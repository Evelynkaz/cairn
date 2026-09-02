// Background vector indexer -- the thing that keeps `remember()` from ever
// having to wait on a model.
//
// BUILD_BRIEF §2 is categorical: "Writes are dumb and instant." `Store.
// remember` stores a memory synchronously and writes NO vector -- embedding
// inference latency is exactly the tax the brief criticises competitors for
// making users pay on every write. Do NOT "helpfully" move embedding onto
// the write path; that would violate the soul of the project, not just a
// style preference.
//
// Instead, memories accumulate in a backlog (rows with no vector row in
// their model's vec0 table -- see `memorySeqsMissingVectors`), and this
// module drains that backlog asynchronously, in the background, at whatever
// pace `provider.embed` can sustain. Until a memory is embedded it is still
// fully findable by FTS (memories_fts is populated synchronously by a
// trigger on insert, independent of vectors) -- so an un-embedded memory is
// a normal, expected, *correct* transient state, not a degraded or broken
// one. Semantic recall simply gets better as the backlog drains; nothing is
// ever unfindable while it waits its turn.

import type { CairnDb } from "../storage/db.js";
import type { VectorSpaceRef } from "../storage/repositories/vectors.js";
import {
  countMemoriesMissingVectors,
  ensureVectorSpace,
  getVectorSpace,
  memorySeqsMissingVectors,
  setVectorLive,
  upsertVector,
} from "../storage/repositories/vectors.js";
import type { EmbeddingProvider } from "./types.js";

export interface IndexerOptions {
  /** Max memories embedded per provider.embed() call. Default 32, clamped 1..256. */
  batchSize?: number;
  /** Poll cadence when start()ed, in ms. Default 1000. */
  intervalMs?: number;
  /** Observation hook: the indexer never throws into the caller's loop. */
  onError?: (error: unknown) => void;
  /** Forces a full backlog check (and a liveness sync) every N runOnce()
      calls, even when the cheap gate below would otherwise skip it. Default
      60, minimum 1. See the gate's doc comment on why this exists. */
  fullScanEveryTicks?: number;
}

export interface IndexerProgress {
  embedded: number;
  failed: number;
  remaining: number;
}

export interface Indexer {
  readonly running: boolean;
  readonly space: VectorSpaceRef;
  /** Processes at most one batch. */
  runOnce(): Promise<IndexerProgress>;
  /** Loops runOnce() until the backlog is empty or a batch makes no progress. */
  drain(): Promise<IndexerProgress>;
  start(): void;
  stop(): Promise<void>;
  /** Marks the indexer dirty so the NEXT runOnce() bypasses the idle gate
      below and runs a real backlog check (plus a liveness sync), even if
      the cheap high-water-mark comparison would otherwise skip it. A caller
      that makes a memory eligible again WITHOUT inserting it (e.g. restoring
      a soft-deleted memory: no new seq is ever created) must call this,
      because the high-water mark alone cannot observe that change. */
  requestFullScan(): void;
}

const DEFAULT_BATCH_SIZE = 32;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 256;
const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_FULL_SCAN_EVERY_TICKS = 60;

function clampBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_BATCH_SIZE;
  }
  return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, Math.trunc(value)));
}

function clampIntervalMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.max(0, Math.trunc(value));
}

function clampFullScanEveryTicks(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_FULL_SCAN_EVERY_TICKS;
  }
  return Math.max(1, Math.trunc(value));
}

// Un-writer for the `live` metadata column that upsertVector's `live: true`
// stamps at embed time: nothing else ever flips it back, so a soft-deleted
// or superseded memory's vector row would otherwise read `live: 1` forever,
// making the `live` filter on knn() unusable and leaving the embedding of
// deleted text on disk indefinitely (BUILD_BRIEF §10 wants deletion
// complete, not partial). This is exported (rather than kept private to
// runOnce's periodic sweep) so a restore path can also invoke it directly.
// Demotes every memory_seq present in the vector space but absent from
// memories_live, and promotes any that are present again (a restore).
export function syncVectorLiveness(db: CairnDb, space: VectorSpaceRef): { demoted: number; promoted: number } {
  // Re-fetched from the registry rather than trusting `space` as given:
  // this function interpolates the table name into raw SQL below, before
  // ever reaching a vectors.ts writer that would otherwise catch a
  // malformed one (see vectors.ts's own "defence in depth" comment on
  // assertTableName). getVectorSpace() -> toRef() revalidates it.
  const trusted = getVectorSpace(db, space.modelId, space.dim);
  if (!trusted) {
    return { demoted: 0, promoted: 0 };
  }
  const tableName = trusted.tableName;

  const toDemote = db
    .q(
      `select v.memory_seq as seq from ${tableName} v
       left join memories_live m on m.seq = v.memory_seq
       where v.live = 1 and m.seq is null`,
    )
    .all()
    .map((row) => Number(row["seq"]));
  const toPromote = db
    .q(
      `select v.memory_seq as seq from ${tableName} v
       inner join memories_live m on m.seq = v.memory_seq
       where v.live = 0`,
    )
    .all()
    .map((row) => Number(row["seq"]));

  if (toDemote.length === 0 && toPromote.length === 0) {
    return { demoted: 0, promoted: 0 };
  }

  db.tx(() => {
    for (const seq of toDemote) {
      setVectorLive(db, trusted, seq, false);
    }
    for (const seq of toPromote) {
      setVectorLive(db, trusted, seq, true);
    }
  });

  return { demoted: toDemote.length, promoted: toPromote.length };
}

export function createIndexer(db: CairnDb, provider: EmbeddingProvider, options: IndexerOptions = {}): Indexer {
  if (!db.capabilities.vectors) {
    throw new Error(
      "cannot create an embedding indexer: vector support is unavailable on this database " +
        `(capabilities.vectorError: ${db.capabilities.vectorError ?? "unknown"}). An indexer with ` +
        "nowhere to write vectors is a configuration mistake worth surfacing, not something to silently no-op.",
    );
  }

  // Relies on the EmbeddingProvider contract's invariant 3 (types.ts):
  // `provider.dim` is final and strictly positive by the time a provider
  // exists, so the space stamped here can never be created from a
  // placeholder dimension that later turns out to be wrong.
  const space = ensureVectorSpace(db, provider.modelId, provider.dim);
  const batchSize = clampBatchSize(options.batchSize);
  const intervalMs = clampIntervalMs(options.intervalMs);
  const fullScanEveryTicks = clampFullScanEveryTicks(options.fullScanEveryTicks);
  const onError = options.onError;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<IndexerProgress> | undefined;
  let isRunning = false;
  // Separate from isRunning/the public `running` getter, which only track
  // start()/stop()'s polling schedule: drain() must fully process a manual,
  // never-started call (isRunning is false for the whole duration of one of
  // those), but must also abort an in-flight pass promptly once stop() is
  // called on a running indexer. See drain()'s loop and stop() below.
  let stopRequested = false;

  // --- Idle-gate state for runOnce()'s backlog check (fix for the "idle
  // daemon burns a core forever" issue) ---
  // The high-water mark is `select seq from memories order by seq desc
  // limit 1`: an O(1) index-only lookup (seq is the AUTOINCREMENT rowid),
  // vastly cheaper than the O(memories) anti-join memorySeqsMissingVectors
  // runs. If it has not moved since the last pass AND that last pass found
  // an empty backlog, nothing that a new insert would have created is
  // possible, so the anti-join is skipped entirely.
  //
  // WHY THE HIGH-WATER MARK ALONE IS NOT ENOUGH: it only proves nothing was
  // INSERTED. A memory can become newly eligible for embedding without a
  // new seq ever being created -- the concrete case is a soft-deleted
  // memory being restored (deleted_at cleared on an existing row). The gate
  // would then wrongly conclude nothing changed and stay idle forever.
  // Two safety nets cover that: `requestFullScan()`, which a restore path
  // calls to force the next check regardless of the gate, and a periodic
  // full check every `fullScanEveryTicks` runOnce() calls (default 60) that
  // ignores the gate on a fixed cadence even if nobody calls it explicitly.
  let lastHighWaterMark: number | undefined;
  let lastPassFoundNothing = false;
  let tickCount = 0;
  let forceFullScan = false;

  function currentHighWaterMark(): number {
    const row = db.q("select seq from memories order by seq desc limit 1").get();
    return row ? Number(row["seq"]) : 0;
  }

  function remainingCount(): number {
    return countMemoriesMissingVectors(db, space);
  }

  async function runOnce(): Promise<IndexerProgress> {
    const highWaterMark = currentHighWaterMark();
    const dueForPeriodicFullScan = forceFullScan || tickCount % fullScanEveryTicks === 0;
    tickCount += 1;

    if (dueForPeriodicFullScan) {
      forceFullScan = false;
      // Same reduced cadence as the backlog full-scan below, not every
      // tick: this is another O(memories) anti-join (see syncVectorLiveness
      // above), and running it on every poll would reintroduce the exact
      // idle-CPU problem this whole gate exists to fix.
      syncVectorLiveness(db, space);
    }

    const mustCheckBacklog =
      dueForPeriodicFullScan ||
      lastHighWaterMark === undefined ||
      highWaterMark !== lastHighWaterMark ||
      !lastPassFoundNothing;
    if (!mustCheckBacklog) {
      return { embedded: 0, failed: 0, remaining: 0 };
    }

    const seqs = memorySeqsMissingVectors(db, space, batchSize);
    lastHighWaterMark = highWaterMark;
    lastPassFoundNothing = seqs.length === 0;
    if (seqs.length === 0) {
      return { embedded: 0, failed: 0, remaining: 0 };
    }

    // Reads memories_live directly rather than going through the memories
    // repository: selecting text/scope/created_at for a specific backlog of
    // seqs is a vector-indexing concern, not a memory-domain query. Each seq
    // is bound as its own placeholder -- never string-interpolated.
    const placeholders = seqs.map(() => "?").join(", ");
    const rows = db
      .q(`select seq, text, scope, created_at from memories_live where seq in (${placeholders})`)
      .all(...seqs);

    if (rows.length === 0) {
      // Every candidate stopped being live between the query above and this
      // one -- nothing to embed this round, and nothing failed either.
      return { embedded: 0, failed: 0, remaining: remainingCount() };
    }

    const texts = rows.map((row) => String(row["text"]));
    let vectors: Float32Array[];
    try {
      // One call for the whole batch: a per-row call would defeat the
      // batching the provider contract exists to enable.
      vectors = await provider.embed(texts);
    } catch (error) {
      onError?.(error);
      // These rows keep no vector row, so they simply stay in the backlog
      // (and stay FTS-findable) until a later drain(); no retry loop here.
      return { embedded: 0, failed: rows.length, remaining: remainingCount() };
    }

    let embedded = 0;
    db.tx(() => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row) continue;
        const seq = Number(row["seq"]);
        // Re-check liveness at write time: provider.embed() above can be
        // slow, and the memory may have been forgotten or superseded during
        // that window. A seq no longer in memories_live is skipped here --
        // counted as neither embedded nor failed.
        const stillLive = db.q("select 1 from memories_live where seq = ?").get(seq);
        if (!stillLive) continue;
        const vector = vectors[i];
        if (!vector) continue;
        upsertVector(db, space, seq, vector, {
          scope: String(row["scope"]),
          live: true,
          createdAt: Number(row["created_at"]),
        });
        embedded += 1;
      }
    });

    return { embedded, failed: 0, remaining: remainingCount() };
  }

  async function drain(): Promise<IndexerProgress> {
    const totals: IndexerProgress = { embedded: 0, failed: 0, remaining: 0 };
    for (;;) {
      if (stopRequested) {
        // stop() was called while this drain() was mid-backlog: honor it
        // now rather than grinding through the rest of a potentially huge
        // backlog first. stop() clears stopRequested at the START of the
        // next start()/stop() cycle, and is currently awaiting this exact
        // promise -- see stop() below.
        break;
      }
      const progress = await runOnce();
      totals.embedded += progress.embedded;
      totals.failed += progress.failed;
      totals.remaining = progress.remaining;
      if (progress.embedded === 0) {
        // No forward progress this round: the backlog was already empty,
        // every candidate stopped being live, or the whole batch failed and
        // would simply be reselected next time. None of those can be fixed
        // by looping again, so stop rather than spin.
        break;
      }
    }
    return totals;
  }

  function scheduleNext(): void {
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = drain().catch((error) => {
        onError?.(error);
        return { embedded: 0, failed: 0, remaining: 0 };
      });
      inFlight.then(() => {
        inFlight = undefined;
        if (isRunning) {
          scheduleNext();
        }
      });
    }, intervalMs);
    // A running indexer must never keep a CLI process alive on its own.
    timer.unref();
  }

  return {
    get running(): boolean {
      return isRunning;
    },
    space,
    runOnce,
    drain,
    requestFullScan(): void {
      forceFullScan = true;
    },
    start(): void {
      if (isRunning) {
        return;
      }
      isRunning = true;
      stopRequested = false;
      scheduleNext();
    },
    async stop(): Promise<void> {
      isRunning = false;
      stopRequested = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (inFlight !== undefined) {
        await inFlight;
      }
    },
  };
}
