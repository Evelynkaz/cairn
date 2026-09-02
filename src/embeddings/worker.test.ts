import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { makeTempDir, tempDbPath } from "../testing/tmp.js";
import { openDb } from "../storage/db.js";
import type { CairnDb } from "../storage/db.js";
import { knn, listVectorSpaces, memorySeqsMissingVectors } from "../storage/repositories/vectors.js";
import { uuidv7 } from "../util/id.js";
import { contentHash } from "../util/text.js";
import { createFakeProvider } from "./fake.js";
import { createHttpProvider } from "./http.js";
import { createIndexer } from "./worker.js";
import type { IndexerProgress } from "./worker.js";

// withTempDir's cleanup runs synchronously right after its callback returns,
// so an async callback (one that returns a Promise) would have its temp dir
// removed before the awaited work inside it finishes (see the identical
// helper in ../storage/repositories/memories.test.ts). Manage the temp dir
// manually here instead.
async function withDbAsync<T>(fn: (db: CairnDb) => Promise<T>): Promise<T> {
  const dir = makeTempDir();
  const db = openDb({ path: tempDbPath(dir) });
  try {
    return await fn(db);
  } finally {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Best-effort: never mask the real failure from fn() with a cleanup error.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Inserted with direct SQL rather than the Store/memories repository, which
// is out of scope for this file to touch or depend on.
function insertMemoryRow(db: CairnDb, overrides: Partial<{ text: string; scope: string }> = {}): string {
  const id = uuidv7();
  const text = overrides.text ?? id;
  const now = Date.now();
  db.q(
    `INSERT INTO memories (id, text, scope, importance, created_at, updated_at, valid_from, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, text, overrides.scope ?? "default", 0.5, now, now, now, contentHash(text));
  return id;
}

function seqOf(db: CairnDb, id: string): number {
  const row = db.q("select seq from memories where id = ?").get(id);
  return Number(row?.["seq"]);
}

function softDelete(db: CairnDb, id: string): void {
  db.q("update memories set deleted_at = ? where id = ?").run(Date.now(), id);
}

test("drain() embeds a large backlog in batches, calling the provider once per batch, not once per row", async () => {
  await withDbAsync(async (db) => {
    for (let i = 0; i < 100; i++) {
      insertMemoryRow(db, { text: `memory number ${i}` });
    }
    const provider = createFakeProvider();
    const indexer = createIndexer(db, provider, { batchSize: 32 });

    const totals = await indexer.drain();

    assert.equal(totals.embedded, 100);
    assert.equal(totals.failed, 0);
    assert.equal(totals.remaining, 0);
    assert.equal(provider.calls, 4, "100 memories at batchSize 32 must take exactly 4 embed() calls");
    assert.equal(provider.textsEmbedded, 100);
    assert.equal(memorySeqsMissingVectors(db, indexer.space, 200).length, 0);
  });
});

test("runOnce on an empty backlog returns zeros and never calls the provider", async () => {
  await withDbAsync(async (db) => {
    const provider = createFakeProvider();
    const indexer = createIndexer(db, provider);

    const progress = await indexer.runOnce();

    assert.deepEqual(progress, { embedded: 0, failed: 0, remaining: 0 });
    assert.equal(provider.calls, 0);
  });
});

test("KNN through knn() finds a memory the indexer embedded", async () => {
  await withDbAsync(async (db) => {
    insertMemoryRow(db, { text: "the quick brown fox jumps over the lazy dog" });
    const provider = createFakeProvider();
    const indexer = createIndexer(db, provider);

    await indexer.drain();

    const [queryVector] = await provider.embed(["the quick brown fox jumps over the lazy dog"]);
    const hits = knn(db, indexer.space, queryVector!, { k: 5 });

    assert.equal(hits.length, 1);
  });
});

// The composition test whose absence let the real bug through: fake.ts and
// http.ts each pass their own tests in isolation, but nobody exercised an
// http-backed provider through createIndexer end to end. This must fail if
// createHttpProvider ever goes back to resolving with `dim: 0` before the
// first embed() -- ensureVectorSpace() rejects a non-positive dim, so
// createIndexer() would throw synchronously instead of ever reaching drain().
function startStub(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("stub server did not report a port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function readJsonBody(req: IncomingMessage): Promise<{ input?: string[] }> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error as Error);
      }
    });
  });
}

const STUB_DIM = 8;

// Deterministic (same text -> same vector, every call), so a memory's own
// text queried back through KNN finds itself -- meaning is irrelevant here,
// only identity is.
function deterministicEmbedding(text: string): number[] {
  const digest = createHash("sha256").update(text).digest();
  const out: number[] = [];
  for (let i = 0; i < STUB_DIM; i++) {
    out.push(digest.readUInt32BE(i * 4));
  }
  return out;
}

test("an http-backed provider indexes real memories through createIndexer and is findable by KNN", async () => {
  const stub = await startStub((req, res) => {
    readJsonBody(req)
      .then((body) => {
        const texts = body.input ?? [];
        const embeddings = texts.map((text) => deterministicEmbedding(text));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ embeddings }));
      })
      .catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
  });
  try {
    await withDbAsync(async (db) => {
      const text = "the http provider composition test memory";
      insertMemoryRow(db, { text });
      const provider = await createHttpProvider({
        name: "ollama",
        baseUrl: stub.url,
        modelId: "composition-test-model",
      });
      assert.equal(provider.dim, STUB_DIM, "an indexable provider must report a positive dim, probed here");

      const indexer = createIndexer(db, provider);
      const totals = await indexer.drain();
      assert.equal(totals.embedded, 1);

      const [queryVector] = await provider.embed([text]);
      const hits = knn(db, indexer.space, queryVector!, { k: 5 });

      assert.equal(hits.length, 1);
    });
  } finally {
    await stub.close();
  }
});

test("a memory forgotten during inference is skipped: neither embedded nor failed, and no vector is written", async () => {
  await withDbAsync(async (db) => {
    const id = insertMemoryRow(db, { text: "forget me mid-flight" });
    const seq = seqOf(db, id);
    // A deterministic barrier instead of racing sleep(20) against
    // latencyMs: onEmbedStart fires synchronously the moment embed() is
    // entered, so the soft delete is guaranteed to land while embed() is
    // still suspended, with no dependence on wall-clock scheduling.
    const provider = createFakeProvider({
      onEmbedStart: () => {
        softDelete(db, id);
      },
    });
    const indexer = createIndexer(db, provider);

    const progress = await indexer.runOnce();

    assert.equal(progress.embedded, 0);
    assert.equal(progress.failed, 0);
    assert.equal(provider.calls, 1, "the provider must still have been called once for the batch");

    const vectorRow = db.q(`select 1 from ${indexer.space.tableName} where memory_seq = ?`).get(seq);
    assert.equal(vectorRow, undefined, "a memory forgotten mid-inference must never get a vector row");
  });
});

test("a provider that always rejects: drain() terminates, onError fires, and memories stay unembedded and FTS-findable", async () => {
  await withDbAsync(async (db) => {
    for (let i = 0; i < 5; i++) {
      insertMemoryRow(db, { text: `always fails ${i}` });
    }
    const provider = createFakeProvider({ failOn: () => true });
    const errors: unknown[] = [];
    const indexer = createIndexer(db, provider, { batchSize: 2, onError: (error) => errors.push(error) });

    const guardMs = 2000;
    const totals = await Promise.race([
      indexer.drain(),
      new Promise<IndexerProgress>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`drain() did not terminate within ${guardMs}ms`)), guardMs);
      }),
    ]);

    assert.equal(totals.embedded, 0);
    assert.ok(totals.failed > 0, "at least one batch must have been attempted and reported failed");
    assert.ok(errors.length > 0, "onError must have fired");
    assert.equal(memorySeqsMissingVectors(db, indexer.space, 200).length, 5, "all 5 memories remain unembedded");

    const ftsHits = db.q("select rowid from memories_fts where memories_fts match ?").all("always");
    assert.equal(ftsHits.length, 5, "unembedded memories must still be FTS-findable");
  });
});

test("stop() awaits an in-flight pass so nothing is running after it resolves", async () => {
  await withDbAsync(async (db) => {
    for (let i = 0; i < 12; i++) {
      insertMemoryRow(db, { text: `slow ${i}` });
    }
    const provider = createFakeProvider({ latencyMs: 20 });
    const indexer = createIndexer(db, provider, { batchSize: 1, intervalMs: 5 });

    indexer.start();
    await sleep(30); // the first scheduled pass is now mid-drain
    await indexer.stop();

    assert.equal(indexer.running, false);
    const callsAtStop = provider.calls;
    await sleep(150);
    assert.equal(provider.calls, callsAtStop, "no more embed() calls should happen once stop() has resolved");
  });
});

test("stop() aborts an in-flight drain after roughly one batch instead of waiting for the whole backlog", async () => {
  await withDbAsync(async (db) => {
    const backlogSize = 200;
    for (let i = 0; i < backlogSize; i++) {
      insertMemoryRow(db, { text: `bulk ${i}` });
    }
    // batchSize 1 means fully draining this backlog takes `backlogSize`
    // embed() calls at latencyMs each -- if stop() waited for all of them,
    // this test would take ~6s. It must resolve after roughly one instead.
    const provider = createFakeProvider({ latencyMs: 30 });
    const indexer = createIndexer(db, provider, { batchSize: 1, intervalMs: 5 });

    indexer.start();
    await sleep(15); // the first scheduled pass is now mid-batch (embed() takes 30ms)
    const stopStartedAt = Date.now();
    await indexer.stop();
    const stopElapsedMs = Date.now() - stopStartedAt;

    assert.ok(stopElapsedMs < 500, `stop() took ${stopElapsedMs}ms, expected it to abort after ~1 batch`);
    assert.ok(
      provider.calls < backlogSize,
      `stop() should have aborted before draining the whole backlog, but provider was called ${provider.calls} times`,
    );
  });
});

test("stop() is idempotent", async () => {
  await withDbAsync(async (db) => {
    insertMemoryRow(db, { text: "one memory" });
    const provider = createFakeProvider();
    const indexer = createIndexer(db, provider, { intervalMs: 5 });

    indexer.start();
    await sleep(20);
    await indexer.stop();
    await indexer.stop(); // must not throw and must resolve immediately
    assert.equal(indexer.running, false);
  });
});

test("start() while already running is a no-op: a second start() does not double the polling rate", async () => {
  await withDbAsync(async (db) => {
    insertMemoryRow(db, { text: "always fails" });
    const provider = createFakeProvider({ failOn: () => true });
    const indexer = createIndexer(db, provider, { batchSize: 10, intervalMs: 30, onError: () => {} });

    indexer.start();
    indexer.start(); // must be a no-op; a double-scheduled timer would roughly double the polling rate below

    await sleep(160); // roughly 5 intervals at single cadence
    await indexer.stop();

    assert.ok(provider.calls <= 8, `expected single-cadence polling (~5 calls), got ${provider.calls}`);
    assert.ok(provider.calls >= 2, `expected the indexer to actually be polling, got ${provider.calls}`);
  });
});

test("a second drain() after new memories arrive embeds only the new ones", async () => {
  await withDbAsync(async (db) => {
    for (let i = 0; i < 5; i++) {
      insertMemoryRow(db, { text: `first batch ${i}` });
    }
    const provider = createFakeProvider();
    const indexer = createIndexer(db, provider);

    const first = await indexer.drain();
    assert.equal(first.embedded, 5);

    for (let i = 0; i < 3; i++) {
      insertMemoryRow(db, { text: `second batch ${i}` });
    }
    const second = await indexer.drain();

    assert.equal(second.embedded, 3);
    assert.equal(provider.textsEmbedded, 8);
  });
});

test("constructing an indexer with vectors disabled throws a descriptive error", () => {
  const dir = makeTempDir();
  const previous = process.env["CAIRN_NO_VECTORS"];
  process.env["CAIRN_NO_VECTORS"] = "1";
  let db: CairnDb | undefined;
  try {
    db = openDb({ path: tempDbPath(dir) });
    assert.equal(db.capabilities.vectors, false);
    const provider = createFakeProvider();
    assert.throws(() => createIndexer(db!, provider), /vector support is unavailable/);
  } finally {
    if (previous === undefined) {
      delete process.env["CAIRN_NO_VECTORS"];
    } else {
      process.env["CAIRN_NO_VECTORS"] = previous;
    }
    db?.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Best-effort: never mask the real failure from fn() with a cleanup error.
    }
  }
});

test("a drained, idle indexer's later ticks skip the expensive backlog anti-join entirely", async () => {
  await withDbAsync(async (db) => {
    for (let i = 0; i < 3; i++) {
      insertMemoryRow(db, { text: `idle gate memory ${i}` });
    }
    const provider = createFakeProvider();
    const indexer = createIndexer(db, provider);

    await indexer.drain();
    assert.equal(memorySeqsMissingVectors(db, indexer.space, 50).length, 0);
    const callsAfterDrain = provider.calls;

    // Spy on db.q, counting only calls to the specific backlog query
    // (memorySeqsMissingVectors orders by m.seq -- countMemoriesMissingVectors
    // and syncVectorLiveness's queries do not), to prove the anti-join is
    // never issued once the gate has established the backlog is empty.
    let backlogQueryCalls = 0;
    const originalQ = db.q.bind(db);
    db.q = (sql: string) => {
      if (sql.includes("order by m.seq asc")) {
        backlogQueryCalls += 1;
      }
      return originalQ(sql);
    };
    try {
      for (let i = 0; i < 5; i++) {
        const progress = await indexer.runOnce();
        assert.deepEqual(progress, { embedded: 0, failed: 0, remaining: 0 });
      }
    } finally {
      db.q = originalQ;
    }

    assert.equal(backlogQueryCalls, 0, "an idle, fully-drained indexer must skip the anti-join on later ticks");
    assert.equal(provider.calls, callsAfterDrain, "no embed() calls should happen once the backlog is already drained");
  });
});

test("a new insert after the backlog was drained is still picked up (the gate does not get stuck skipping)", async () => {
  await withDbAsync(async (db) => {
    insertMemoryRow(db, { text: "first" });
    const provider = createFakeProvider();
    const indexer = createIndexer(db, provider);

    await indexer.drain();
    assert.equal(provider.textsEmbedded, 1);

    insertMemoryRow(db, { text: "second, inserted after the backlog was empty" });
    const progress = await indexer.runOnce();

    assert.equal(progress.embedded, 1, "the high-water mark moving must defeat the gate");
    assert.equal(provider.textsEmbedded, 2);
  });
});

test("requestFullScan() demotes a soft-deleted memory's vector row to live=0, and a restore promotes it back to live=1", async () => {
  await withDbAsync(async (db) => {
    const id = insertMemoryRow(db, { text: "liveness sync me" });
    const seq = seqOf(db, id);
    const provider = createFakeProvider();
    const indexer = createIndexer(db, provider);
    await indexer.drain();

    const liveBefore = db.q(`select live from ${indexer.space.tableName} where memory_seq = ?`).get(seq);
    assert.equal(liveBefore?.["live"], 1);

    softDelete(db, id);
    // The high-water mark alone cannot see this change (no new seq was
    // created), which is exactly why requestFullScan() exists.
    indexer.requestFullScan();
    await indexer.runOnce();

    const liveAfterDelete = db.q(`select live from ${indexer.space.tableName} where memory_seq = ?`).get(seq);
    assert.equal(liveAfterDelete?.["live"], 0, "a soft-deleted memory's vector row must be demoted to live=0");
    const rowStillExists = db
      .q(`select count(*) as c from ${indexer.space.tableName} where memory_seq = ?`)
      .get(seq);
    assert.equal(rowStillExists?.["c"], 1, "demoting must not delete the row -- only the live flag changes");

    db.q("update memories set deleted_at = null where id = ?").run(id);
    indexer.requestFullScan();
    await indexer.runOnce();

    const liveAfterRestore = db.q(`select live from ${indexer.space.tableName} where memory_seq = ?`).get(seq);
    assert.equal(liveAfterRestore?.["live"], 1, "a restored memory's vector row must be promoted back to live=1");
  });
});

test("a periodic full scan resyncs liveness on its own cadence, without ever calling requestFullScan()", async () => {
  await withDbAsync(async (db) => {
    const id = insertMemoryRow(db, { text: "periodic sync me" });
    const seq = seqOf(db, id);
    const provider = createFakeProvider();
    const indexer = createIndexer(db, provider, { fullScanEveryTicks: 3 });
    await indexer.drain();

    softDelete(db, id);
    for (let i = 0; i < 5; i++) {
      await indexer.runOnce();
    }

    const live = db.q(`select live from ${indexer.space.tableName} where memory_seq = ?`).get(seq);
    assert.equal(
      live?.["live"],
      0,
      "a periodic full scan must eventually demote a soft-deleted memory without an explicit requestFullScan()",
    );
  });
});

test("IndexerProgress.remaining reports the true backlog size and does not saturate at memorySeqsMissingVectors's 500-row clamp", async () => {
  await withDbAsync(async (db) => {
    const total = 600;
    for (let i = 0; i < total; i++) {
      insertMemoryRow(db, { text: `remaining count memory ${i}` });
    }
    const provider = createFakeProvider();
    const indexer = createIndexer(db, provider, { batchSize: 10 });

    const progress = await indexer.runOnce();

    assert.equal(progress.embedded, 10);
    assert.equal(progress.remaining, total - 10, "remaining must reflect the true count, not clamp at 500");
  });
});

test("provider A drains, switching to provider B creates an isolated space whose backlog is the full memory count, and A's rows survive B's drain (BUILD_BRIEF §3)", async () => {
  await withDbAsync(async (db) => {
    for (let i = 0; i < 5; i++) {
      insertMemoryRow(db, { text: `provider switch memory ${i}` });
    }
    const providerA = createFakeProvider({ modelId: "m-a", dim: 32 });
    const indexerA = createIndexer(db, providerA);
    assert.equal(indexerA.space.modelId, providerA.modelId);
    assert.equal(indexerA.space.dim, providerA.dim);
    await indexerA.drain();
    assert.equal(memorySeqsMissingVectors(db, indexerA.space, 50).length, 0);

    const providerB = createFakeProvider({ modelId: "m-b", dim: 16 });
    const indexerB = createIndexer(db, providerB);
    assert.equal(indexerB.space.modelId, providerB.modelId);
    assert.equal(indexerB.space.dim, providerB.dim);

    // A provider switch is a background re-embed, not a destructive
    // migration: the new space starts with the full memory count in its
    // backlog, since nothing has been embedded into it yet.
    assert.equal(memorySeqsMissingVectors(db, indexerB.space, 50).length, 5);

    const spaces = listVectorSpaces(db);
    assert.equal(spaces.length, 2);
    const spaceA = spaces.find((s) => s.modelId === "m-a");
    const spaceB = spaces.find((s) => s.modelId === "m-b");
    assert.equal(spaceA?.dim, 32);
    assert.equal(spaceB?.dim, 16);

    const countABefore = db.q(`select count(*) as c from ${indexerA.space.tableName}`).get();
    await indexerB.drain();

    assert.equal(memorySeqsMissingVectors(db, indexerB.space, 50).length, 0);
    const countAAfter = db.q(`select count(*) as c from ${indexerA.space.tableName}`).get();
    assert.equal(countAAfter?.["c"], countABefore?.["c"], "space A's rows must be untouched by draining space B");
    assert.equal(countAAfter?.["c"], 5);
  });
});
