// The single object the daemon, the CLI and the MCP tool layer all use.
// Composes the repositories and owns the three cross-cutting concerns none
// of them can own alone (BUILD_BRIEF §5, §9): episode provenance, audit
// trails, and per-client gating. No retrieval (recall/get_context, §7) and
// no embeddings live here — those are milestones 2 and 3.

import { openDb } from "./db.js";
import type { CairnDb, DbCapabilities } from "./db.js";
import type { DriverFactory } from "./driver/index.js";
import type { Memory, ClientRecord, Episode } from "./types.js";
import { assertTableName, listVectorSpaces, type VectorSpaceRef } from "./repositories/vectors.js";
import { appendEpisode, getEpisode, importEpisode as importEpisodeRepo, listEpisodes } from "./repositories/episodes.js";
import type { ImportEpisodeResult } from "./repositories/episodes.js";
import {
  createMemory,
  getMemory,
  importMemory as importMemoryRepo,
  listMemories,
  memoriesAsOf,
  restoreMemory,
  softDeleteMemory,
  supersedeMemory,
  touchMemory,
  updateMemory,
} from "./repositories/memories.js";
import type { ImportMemoryResult } from "./repositories/memories.js";
import {
  countAuditByClient,
  isClientEnabled,
  listAudit,
  listClients,
  recordAudit,
  registerClient,
  setClientEnabled as setClientEnabledRepo,
} from "./repositories/audit.js";
import type { AuditAction } from "./repositories/audit.js";
import { recordRedactions } from "./repositories/redactions.js";
import { search, getContext } from "../retrieval/index.js";
import type { SearchDeps, SearchOptions, SearchResult, ContextOptions, ContextBlock } from "../retrieval/index.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { clampLimit, encodeCursor } from "./repositories/paging.js";
import { memoryStats } from "./repositories/stats.js";
import type { StoreStats, StoreStatsOptions } from "./repositories/stats.js";
import { redactText } from "../privacy/index.js";
import type { Finding, SecretKind, PrivacyMode } from "../privacy/index.js";
import { resolvePrivacyMode, setPrivacyMode } from "./privacy-settings.js";
import type { PrivacyConfig } from "./privacy-settings.js";
import { listRedactions, countRedactionsByKind } from "./repositories/redactions.js";
import type { ListRedactionsOptions, ListRedactionsResult, RedactionKindCount } from "./repositories/redactions.js";
import { MAX_TAGS, MAX_TAG_LENGTH, MAX_SCOPE_LENGTH, MAX_CONTENT_LENGTH } from "./limits.js";

export interface StoreOptions {
  path?: string;
  driver?: DriverFactory;
  readOnly?: boolean;
  // Retrieval config for recall()/context() below (BUILD_BRIEF §7). Both
  // optional so a store stays fully usable with neither -- the §2 FTS-only
  // default, not an error -- and a per-call StoreRecallOptions/
  // StoreContextOptions may override either.
  provider?: EmbeddingProvider | null;
  space?: VectorSpaceRef | null;
}

export interface StoreRecallOptions extends SearchOptions {
  /** Overrides the store's own configured provider for this one call. Pass
      explicitly (including `null`) to force FTS-only regardless of what the
      store was constructed with. */
  provider?: EmbeddingProvider | null;
  space?: VectorSpaceRef | null;
}

export interface StoreContextOptions extends ContextOptions {
  /** Overrides the store's own configured provider for this one call. Pass
      explicitly (including `null`) to force FTS-only regardless of what the
      store was constructed with. */
  provider?: EmbeddingProvider | null;
  space?: VectorSpaceRef | null;
}

export interface CallContext {
  sourceClient?: string | null;
  scope?: string;
}

export interface Store {
  /** @internal — tests and migration tooling only. */
  readonly db: CairnDb;
  readonly capabilities: DbCapabilities;

  remember(
    input: {
      content: string;
      tags?: string[];
      scope?: string;
      importance?: number;
      metadata?: Record<string, unknown>;
    },
    ctx?: CallContext,
  ): {
    memory: Memory;
    deduped: boolean;
    // On a fresh write, the id of the episode just appended. On dedupe,
    // the memory's EXISTING episode id (whichever it already carried
    // before this call), not the episode just appended by this call --
    // that new episode is still recorded in the log but is not reachable
    // from this return value.
    episodeId: string;
    // §10: what the redactor found in this write, if anything -- kinds and
    // counts only, never previews, so the tool layer decides what (if
    // anything) to surface to the user. Empty when privacy mode is "off"
    // or nothing was found.
    redactions: { kind: SecretKind; count: number }[];
  };
  // A forgotten (or superseded) memory must not be readable by default
  // (BUILD_BRIEF §10): both options default to false. The dashboard's
  // undo path is the caller that passes includeDeleted: true.
  get(
    id: string,
    options?: { includeDeleted?: boolean; includeSuperseded?: boolean },
    ctx?: CallContext,
  ): Memory | undefined;
  list(
    options?: {
      scope?: string;
      tags?: string[];
      sourceClient?: string;
      since?: number;
      until?: number;
      includeDeleted?: boolean;
      includeSuperseded?: boolean;
      limit?: number;
      cursor?: string | null;
    },
    ctx?: CallContext,
  ): { items: Memory[]; nextCursor: string | null };
  // Administrative aggregate for the daemon's unauthenticated /health probe
  // (BUILD_BRIEF §4) -- same live-memory predicate list() defaults to
  // (deleted_at IS NULL AND valid_until IS NULL), as a single count rather
  // than a page of rows, so /health never has to reach past this facade
  // into the internal `db` handle to answer "how many memories".
  countMemories(options?: { scope?: string }): number;

  /** Bounded aggregates for the dashboard's stats panel (BUILD_BRIEF §9). Read-only:
      it is not gated or audited, because it returns counts only and never memory
      content — same reasoning as countMemories() above it. */
  stats(options?: StoreStatsOptions): StoreStats;

  // BUILD_BRIEF §7/§8 hybrid retrieval, wrapped here rather than left to
  // the MCP layer, so the client-pause gate and the access-log audit trail
  // (§9) have exactly one implementation for every read, not one copy per
  // transport. These are the only two async members on Store: unlike
  // everything else here, they may need to embed the query text to run the
  // vector branch -- embedding is the sole asynchronous step anywhere in
  // this read path, and it happens entirely inside search()/getContext().
  recall(query: string, options?: StoreRecallOptions, ctx?: CallContext): Promise<SearchResult>;
  context(query: string, options?: StoreContextOptions, ctx?: CallContext): Promise<ContextBlock>;

  update(
    id: string,
    patch: { text?: string; tags?: string[]; importance?: number },
    ctx?: CallContext,
  ): Memory;
  forget(id: string, ctx?: CallContext): boolean;
  // The query-shaped form of forget (BUILD_BRIEF §6): a preview run
  // (confirm falsy) never mutates anything and is gated/audited as a read;
  // only `confirm: true` deletes, gated/audited as `forget`. This is the
  // only path to retrieval search for `forget`, so the MCP layer has no
  // reason to call the retrieval layer directly (§9/§10 -- every read of
  // memory content goes through the same gate).
  forgetWhere(
    query: string,
    options: { scope?: string; limit?: number; confirm?: boolean },
    ctx?: CallContext,
  ): Promise<{ deleted: boolean; count: number; matches: Array<{ id: string; text: string; scope: string }> }>;
  restore(id: string, ctx?: CallContext): boolean;
  supersede(
    oldId: string,
    input: { text: string; tags?: string[]; importance?: number },
    ctx?: CallContext,
  ): { superseded: Memory; replacement: Memory };
  asOf(at: number, options?: { scope?: string; limit?: number }, ctx?: CallContext): Memory[];

  // §10: "delete everything" is always available and hard-deletes every
  // memory/episode/tag/FTS/vector row in one transaction. Requires
  // `confirm: true`, same gate shape as forgetWhere's query-shaped delete
  // -- a model mis-firing this call must not silently erase the whole
  // store. audit_log, clients, settings and redactions are deliberately
  // NOT purged (see the implementation comment for why).
  deleteEverything(
    options: { confirm: true },
    ctx?: CallContext,
  ): { memories: number; episodes: number; vectors: number };

  // Portability import (BUILD_BRIEF §10/§16 milestone 10): inserts a memory
  // with a CALLER-SUPPLIED id rather than minting one, so that a re-import
  // preserves created_at exactly (see the doc comment on
  // repositories/memories.ts's importMemory for why that is not the same
  // as calling remember()). Never overwrites: an id that already exists,
  // or content already live in that scope, comes back skipped rather than
  // applied, so re-importing the same archive twice is a no-op.
  importMemory(
    input: {
      id: string;
      text: string;
      scope?: string;
      tags?: string[];
      sourceClient?: string | null;
      importance?: number;
      updatedAt?: number;
      validFrom?: number;
      validUntil?: number | null;
      supersededBy?: string | null;
      deletedAt?: number | null;
      redacted?: boolean;
      // Best-effort, same reasoning as supersededBy above (see
      // repositories/memories.ts's importMemory): wired up only if the
      // referenced episode already exists in THIS store at import time, and
      // left null rather than failing the whole import otherwise. archive.ts
      // imports episodes before memories precisely so this reference holds
      // in the ordinary case.
      episodeId?: string | null;
    },
    ctx?: CallContext,
  ): ImportMemoryResult;

  // Portability import for the episodic log, same shape and same reasoning
  // as importMemory above: inserts under the CALLER-SUPPLIED id so created_at
  // (derived from that id) survives the round trip, and never overwrites --
  // an id that already exists comes back skipped rather than applied.
  importEpisode(
    input: {
      id: string;
      content: string;
      scope?: string;
      sourceClient?: string | null;
      metadata?: Record<string, unknown>;
    },
    ctx?: CallContext,
  ): ImportEpisodeResult;

  episodes(
    options?: {
      scope?: string;
      limit?: number;
      cursor?: string | null;
      // §10: a forgotten memory's provenance episode is excluded by
      // default, same as a forgotten memory itself -- opt in to see it.
      includeDeleted?: boolean;
    },
    ctx?: CallContext,
  ): { items: Episode[]; nextCursor: string | null };
  episode(
    id: string,
    ctx?: CallContext,
    options?: { includeDeleted?: boolean },
  ): Episode | undefined;

  auditLog(options?: Parameters<typeof listAudit>[1]): ReturnType<typeof listAudit>;
  clientStats(options?: { since?: number; limit?: number }): ReturnType<typeof countAuditByClient>;
  clients(): ClientRecord[];
  setClientEnabled(id: string, enabled: boolean, ctx?: CallContext): ClientRecord;

  /** §10 privacy mode, as resolved from env then settings then the default. */
  privacy(): PrivacyConfig;
  /** Changes the stored privacy mode. Audited: turning redaction off or down is
      exactly the change a user must be able to find in the access log later. */
  setPrivacy(mode: PrivacyMode, ctx?: CallContext): PrivacyConfig;
  /** §9 "what was blocked": the redaction log. Previews are already masked at
      write time -- never unmask them here. */
  redactions(options?: ListRedactionsOptions): ListRedactionsResult;
  /** §9 privacy panel aggregate: redaction counts by kind and action. */
  redactionStats(options?: { since?: number; limit?: number }): RedactionKindCount[];

  close(): void;
}

// Names the KINDS found and how many, never a value or a preview that
// could reconstruct one -- this is what a strict-mode refusal error is
// allowed to say (BUILD_BRIEF §10).
function summarizeFindings(findings: readonly Finding[]): string {
  const counts = summarizeKindCounts(findings);
  return counts.map(({ kind, count }) => `${count} ${kind}`).join(", ");
}

// Kinds and counts only, never previews -- the tool layer decides what (if
// anything) to surface to the user.
function summarizeKindCounts(findings: readonly Finding[]): { kind: SecretKind; count: number }[] {
  const counts = new Map<SecretKind, number>();
  for (const finding of findings) {
    counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

// §10 "keep the source, but not the secret": forget()/restore() mark the
// forgotten memory's provenance episode alongside it, rather than editing
// episodes.content (append-only, §5) or requiring a schema change. A plain
// JSON key on the existing metadata column, cleared by restore(), is enough
// for episodes()/episode() below to exclude it by default -- the same
// includeDeleted-style opt-in memories already have.
const FORGOTTEN_KEY = "_forgotten";

function markEpisodeForgotten(db: CairnDb, episodeId: string | null | undefined, forgotten: boolean): void {
  if (!episodeId) return;
  const episode = getEpisode(db, episodeId);
  if (!episode) return;
  const metadata = { ...episode.metadata };
  if (forgotten) {
    metadata[FORGOTTEN_KEY] = true;
  } else {
    delete metadata[FORGOTTEN_KEY];
  }
  db.q(`UPDATE episodes SET metadata = ? WHERE id = ?`).run(JSON.stringify(metadata), episodeId);
}

function isEpisodeForgotten(episode: Episode): boolean {
  return episode.metadata[FORGOTTEN_KEY] === true;
}

// listEpisodes() applies its LIMIT before episodes() below filters out
// forgotten rows, so a one-shot call can hand back a short (even empty)
// page with a non-null cursor if the newest rows happen to be forgotten --
// measured: 30 episodes with the newest 10 forgotten made
// episodes({limit:10}) return items:0 with a cursor, and the dashboard's
// Timeline renders its "nothing here" empty state on items.length === 0,
// hiding the other 20 behind that cursor. episodes() below re-pages until
// the requested page is full or the underlying cursor is exhausted. Bounded
// at this many underlying fetches so a store that is mostly forgotten
// episodes cannot turn one page request into an unbounded scan -- worst
// case (MAX_PAGE_LIMIT-sized pages, all forgotten) is a bounded number of
// rows examined, not the whole table; the page returned may then still be
// short, but the cursor handed back always lets the caller keep going.
const MAX_FORGOTTEN_SCAN_PAGES = 20;

// A security audit found a single caller-supplied `tags` array re-applied to
// every entry parsed out of a paste import, with nothing anywhere capping
// tag count, tag length, scope length or memory length: a 23,798-byte
// request produced 7.9 minutes of synchronous work on the single-threaded
// daemon, freezing the dashboard and every MCP client on the machine for the
// duration. src/dashboard/api.ts's clampTags/clampScope close that off for
// every HTTP caller, but `remember`/`update`/`supersede`/the import methods
// on THIS Store are the one chokepoint every write path shares -- HTTP,
// every MCP tool, and both import methods all call in here -- so the bound
// has to live here too, or an MCP client (which never touches api.ts) still
// reaches an unbounded store. The limit numbers themselves live in
// ./limits.js, imported by both this file and api.ts, so the two
// enforcement sites can never drift apart the way they already have once.
//
// A cap is refused with a thrown Error, never silently truncated: api.ts
// already decided a 400 is right at the HTTP boundary because the caller
// can fix the request and retry; the same reasoning holds one layer down --
// a caller close enough to hit the store directly (every MCP tool) can
// equally retry with a shorter list, whereas truncating would silently drop
// tags a user asked to keep, which is data loss they never asked for and
// never observe.
//
// Checked and refused BEFORE redactText ever runs, for the same reason the
// regex crashed in the first place (see ./limits.js) -- an over-cap string
// must never reach that pass at all, so refusing here also doubles as the
// fix for the stack exhaustion, not just the byte-count amplification.

function assertTagsWithinCap(tags: string[] | undefined): void {
  if (tags === undefined) return;
  if (tags.length > MAX_TAGS) {
    throw new Error(`tags exceeds the cap of ${MAX_TAGS}`);
  }
  for (const tag of tags) {
    if (tag.length > MAX_TAG_LENGTH) {
      throw new Error(`a tag exceeds the cap of ${MAX_TAG_LENGTH} characters`);
    }
  }
}

function assertScopeWithinCap(scope: string | undefined): void {
  if (scope !== undefined && scope.length > MAX_SCOPE_LENGTH) {
    throw new Error(`scope exceeds the cap of ${MAX_SCOPE_LENGTH} characters`);
  }
}

// `field` names the offending parameter ("content"/"text") only -- per
// BUILD_BRIEF §10, an error must never carry memory content or a filesystem
// path, so this message states the limit and the field name, never the
// value.
function assertContentWithinCap(content: string, field: string): void {
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`${field} exceeds the cap of ${MAX_CONTENT_LENGTH} characters`);
  }
}

// episodes.metadata is a FIFTH ingest path (§10): a caller-supplied object
// with no cap and no redaction let a 5,041-character value carrying an
// intact GitHub token straight into episodes.metadata, served verbatim by
// GET /api/episodes/:id and written into exportArchive -- reachable directly
// from `remember`'s `source` parameter (its schema in tools.ts maps into
// here, and is itself unbounded -- see this review's out-of-scope note for
// that file). 4096 (JSON.stringify length, not raw string length) is chosen
// because this column exists for small structured provenance -- client
// name, ids, a handful of flags -- not a second content field:
// MAX_CONTENT_LENGTH (65536) already governs the actual memory text, so
// 4096 is generous for metadata's real purpose while closing off the
// amplification actually measured. Refused, not truncated, for the same
// reason as every other cap in this file: silent truncation is silent data
// loss a caller never asked for.
const MAX_METADATA_LENGTH = 4096;

// Metadata arrives as a plain JSON object from a client or an archive, never
// hand-built application state, so any real use case is shallow. Walked to
// a bounded depth (4) -- rather than fully unbounded recursion -- so a
// maliciously deep/wide structure cannot turn this walk itself into
// unbounded work; the length cap above already bounds the total bytes
// examined, this bounds the STACK DEPTH of examining them. Past the depth
// cap, a nested value is left as-is (already covered by the byte cap, and
// not worth refusing the whole write over).
const MAX_METADATA_DEPTH = 4;

function assertMetadataWithinCap(metadata: Record<string, unknown> | undefined): void {
  if (metadata === undefined) return;
  let serialized: string;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    throw new Error(`metadata must be JSON-serializable`);
  }
  if (serialized.length > MAX_METADATA_LENGTH) {
    throw new Error(`metadata exceeds the cap of ${MAX_METADATA_LENGTH} characters`);
  }
}

function redactMetadataValue(value: unknown, mode: PrivacyMode, depth: number, findings: Finding[]): unknown {
  if (typeof value === "string") {
    const redaction = redactText(value, mode);
    findings.push(...redaction.findings);
    return redaction.text;
  }
  if (depth >= MAX_METADATA_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => redactMetadataValue(entry, mode, depth + 1, findings));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactMetadataValue(entry, mode, depth + 1, findings);
    }
    return out;
  }
  return value;
}

// Same shape and same reasoning as redactText itself: `off` skips the
// detectors entirely (genuinely free), `on` returns rewritten metadata with
// markers spliced in, `strict` returns the ORIGINAL metadata untouched with
// `blocked: true` so the caller refuses the whole write -- never a
// redact-and-store fallback for the mode that exists specifically so the
// user finds out and decides.
function redactMetadata(
  metadata: Record<string, unknown> | undefined,
  mode: PrivacyMode,
): { metadata: Record<string, unknown> | undefined; findings: Finding[]; blocked: boolean } {
  if (metadata === undefined || mode === "off") {
    return { metadata, findings: [], blocked: false };
  }
  const findings: Finding[] = [];
  const redacted = redactMetadataValue(metadata, mode, 0, findings) as Record<string, unknown>;
  if (mode === "strict") {
    return { metadata, findings, blocked: findings.length > 0 };
  }
  return { metadata: redacted, findings, blocked: false };
}

export function openStore(options: StoreOptions = {}): Store {
  const db = openDb({ path: options.path, driver: options.driver, readOnly: options.readOnly });
  const readOnly = options.readOnly ?? false;
  // §10: the .db file is sold as one copyable artifact with no encryption
  // (deferred to v2), so a hard-deleted secret must not simply linger in a
  // freed page waiting for VACUUM (deleteEverything's own VACUUM call
  // handles reclaiming the freed pages themselves). secure_delete is a
  // per-connection pragma, not a stored setting -- it does not write to the
  // db file, so it is safe to set even on a read-only connection.
  db.exec("PRAGMA secure_delete=ON");
  const defaultProvider = options.provider ?? null;
  const defaultSpace = options.space ?? null;

  // Per-call provider/space (StoreRecallOptions/StoreContextOptions) win
  // over the store's own construction-time default when given explicitly
  // (including `null`, to force FTS-only for one call).
  function retrievalDeps(
    callProvider: EmbeddingProvider | null | undefined,
    callSpace: VectorSpaceRef | null | undefined,
  ): SearchDeps {
    return {
      provider: callProvider !== undefined ? callProvider : defaultProvider,
      space: callSpace !== undefined ? callSpace : defaultSpace,
    };
  }

  function requireWritable(method: string): void {
    if (readOnly) {
      throw new Error(`store opened read-only: cannot call ${method}()`);
    }
  }

  // Registers/refreshes the calling client and enforces per-app pause
  // (§9 "per-app enable/pause"). registerClient is a write, so it is
  // skipped on a read-only store (which physically cannot write); the
  // enable check itself is a plain SELECT and still applies, so a paused
  // client stays paused even against a read-only connection. A refusal is
  // itself audited -- a paused app's blocked attempts are what makes the
  // access log a trust anchor rather than a partial view -- except on a
  // read-only store, where recording it would be another write.
  function gate(ctx: CallContext | undefined, action: AuditAction): { sourceClient: string | null; scope: string | undefined } {
    const sourceClient = ctx?.sourceClient ?? null;
    const scope = ctx?.scope;
    if (sourceClient !== null) {
      if (!readOnly) {
        registerClient(db, sourceClient);
      }
      if (!isClientEnabled(db, sourceClient)) {
        if (!readOnly) {
          recordAudit(db, {
            action,
            sourceClient,
            scope: scope ?? null,
            details: { refused: true, reason: "client disabled" },
            refused: true,
          });
        }
        throw new Error(`client "${sourceClient}" is disabled; ${action} refused`);
      }
    }
    return { sourceClient, scope };
  }

  return {
    db,
    capabilities: db.capabilities,

    remember(input, ctx) {
      requireWritable("remember");
      assertContentWithinCap(input.content, "content");
      assertTagsWithinCap(input.tags);
      assertScopeWithinCap(input.scope);
      assertMetadataWithinCap(input.metadata);
      const { sourceClient, scope } = gate(ctx, "remember");
      const resolvedScope = input.scope ?? scope;

      // §10 redaction runs BEFORE anything is written, and is pure local
      // regex (../privacy/detectors.ts) -- it never calls an LLM or the
      // network, so this stays inside `remember`'s "never calls an LLM"
      // contract (BUILD_BRIEF §2). `metadata` is redacted the same way as
      // `content` -- it is a fifth ingest path, not exempt from any of this
      // (see assertMetadataWithinCap's comment above).
      const { mode: privacyMode } = resolvePrivacyMode(db);
      const redaction = redactText(input.content, privacyMode);
      const metadataRedaction = redactMetadata(input.metadata, privacyMode);

      if (privacyMode === "strict" && (redaction.blocked || metadataRedaction.blocked)) {
        // §10 strict mode: write NOTHING -- no episode, no memory, no
        // vector. The refusal must still show up in the §9 "what was
        // blocked" view, so it is recorded here, OUTSIDE the write
        // transaction that never opens for this call -- the same shape as
        // gate()'s client-refusal audit row above, which also records
        // before throwing rather than inside a transaction that would roll
        // it back. The error names the KINDS found and how many, never a
        // value or a preview that could reconstruct one.
        const findings = [...redaction.findings, ...metadataRedaction.findings];
        recordRedactions(
          db,
          findings.map((finding) => ({
            memoryId: null,
            episodeId: null,
            scope: resolvedScope,
            sourceClient,
            kind: finding.kind,
            preview: finding.preview,
            action: "blocked",
          })),
        );
        throw new Error(
          `remember refused: found ${summarizeFindings(findings)}; privacy mode is "strict"`,
        );
      }

      const contentToStore = redaction.text;
      const redacted = redaction.findings.length > 0 || metadataRedaction.findings.length > 0;

      return db.tx(() => {
        // Local-embedding hook lands in milestone 2 here: `remember` must
        // stay local-only and never make a network call in the default
        // path (BUILD_BRIEF §2). No vector is computed or stored yet.

        // The episodic log is append-only and keeps the source (§5), but
        // §10 wins here for secrets: an unredacted episode would put the
        // user's API key in the database, which is the exact outcome this
        // feature exists to prevent. The episode therefore gets the
        // REDACTED text too, not the raw content -- this looks like a §5
        // violation to anyone who has not read §10, but it is not one. Same
        // reasoning for metadata: it gets the redacted object, not the raw
        // one.
        const episode = appendEpisode(db, {
          content: contentToStore,
          scope: resolvedScope,
          sourceClient,
          metadata: metadataRedaction.metadata,
        });
        const { memory, deduped } = createMemory(db, {
          text: contentToStore,
          scope: resolvedScope,
          tags: input.tags,
          sourceClient,
          importance: input.importance,
          episodeId: episode.id,
          redacted,
        });
        if (redacted) {
          recordRedactions(
            db,
            [...redaction.findings, ...metadataRedaction.findings].map((finding) => ({
              memoryId: memory.id,
              episodeId: episode.id,
              scope: resolvedScope,
              sourceClient,
              kind: finding.kind,
              preview: finding.preview,
              action: "redacted",
            })),
          );
        }
        recordAudit(db, {
          action: "remember",
          memoryId: memory.id,
          scope: memory.scope,
          sourceClient,
          details: { deduped },
        });
        // See the episodeId doc comment on the Store interface for what
        // this value means on dedupe vs. a fresh write.
        return {
          memory,
          deduped,
          episodeId: memory.episodeId ?? episode.id,
          redactions: summarizeKindCounts([...redaction.findings, ...metadataRedaction.findings]),
        };
      });
    },

    get(id, options = {}, ctx) {
      // `get` and `list` are both browse/read operations backing the same
      // §6 list_memories tool; there is no dedicated read-by-id action in
      // the capped audit vocabulary, so both share list_memories rather
      // than widening the union.
      const { sourceClient, scope } = gate(ctx, "list_memories");
      const row = getMemory(db, id);
      // §10: a forgotten (or superseded) memory must not be readable by
      // default -- list() already excludes these rows by default, and
      // get() must not disagree with it.
      const included =
        row !== undefined &&
        (options.includeDeleted || row.deletedAt === null) &&
        (options.includeSuperseded || row.validUntil === null);
      let memory = included ? row : undefined;
      if (memory && !readOnly) {
        touchMemory(db, memory.id);
        memory = getMemory(db, memory.id);
      }
      if (!readOnly) {
        recordAudit(db, {
          action: "list_memories",
          memoryId: id,
          scope: row?.scope ?? scope ?? null,
          sourceClient,
          resultCount: memory ? 1 : 0,
        });
      }
      return memory;
    },

    list(options = {}, ctx) {
      const { sourceClient, scope } = gate(ctx, "list_memories");
      const effectiveScope = options.scope ?? scope;
      const result = listMemories(db, { ...options, scope: effectiveScope });
      if (!readOnly) {
        recordAudit(db, {
          action: "list_memories",
          scope: effectiveScope ?? null,
          sourceClient,
          resultCount: result.items.length,
        });
      }
      return result;
    },

    countMemories(options = {}) {
      // Same predicate as listMemories()'s default (no includeDeleted/
      // includeSuperseded): a "live" memory has neither deleted_at nor
      // valid_until set.
      if (options.scope !== undefined) {
        const row = db
          .q(`SELECT COUNT(*) AS c FROM memories WHERE valid_until IS NULL AND deleted_at IS NULL AND scope = ?`)
          .get(options.scope);
        return row ? Number(row["c"]) : 0;
      }
      const row = db.q(`SELECT COUNT(*) AS c FROM memories WHERE valid_until IS NULL AND deleted_at IS NULL`).get();
      return row ? Number(row["c"]) : 0;
    },

    stats(options) {
      return memoryStats(db, options);
    },

    async recall(query, options = {}, ctx) {
      const { sourceClient, scope } = gate(ctx, "recall");
      const effectiveScope = options.scope ?? scope;
      const { provider: callProvider, space: callSpace, ...searchOptions } = options;
      const result = await search(
        db,
        query,
        { ...searchOptions, scope: effectiveScope },
        retrievalDeps(callProvider, callSpace),
      );
      // recordAudit is itself a write; a read-only connection cannot
      // perform one, so -- exactly like every other read on this store
      // (get/list/asOf/episodes/episode above) -- recall silently skips
      // auditing rather than throwing on a read-only store.
      if (!readOnly) {
        recordAudit(db, {
          action: "recall",
          scope: effectiveScope ?? null,
          sourceClient,
          query,
          resultCount: result.hits.length,
        });
      }
      return result;
    },

    async context(query, options = {}, ctx) {
      const { sourceClient, scope } = gate(ctx, "get_context");
      const effectiveScope = options.scope ?? scope;
      const { provider: callProvider, space: callSpace, ...contextOptions } = options;
      const block = await getContext(
        db,
        query,
        { ...contextOptions, scope: effectiveScope },
        retrievalDeps(callProvider, callSpace),
      );
      // See the read-only note on recall() above -- same reasoning.
      if (!readOnly) {
        recordAudit(db, {
          action: "get_context",
          scope: effectiveScope ?? null,
          sourceClient,
          query: query.length > 0 ? query : null,
          resultCount: block.memories.length,
        });
      }
      return block;
    },

    update(id, patch, ctx) {
      requireWritable("update");
      if (patch.text !== undefined) assertContentWithinCap(patch.text, "text");
      assertTagsWithinCap(patch.tags);
      const { sourceClient, scope } = gate(ctx, "update_memory");

      // §10 redaction runs BEFORE anything is written, mirroring remember()
      // exactly: update() is just as capable of putting a secret in
      // memories.text (and memories_fts) as remember() is, and skipped this
      // entirely before this fix.
      let textToStore: string | undefined = patch.text;
      let findings: Finding[] = [];
      if (patch.text !== undefined) {
        const current = getMemory(db, id);
        const { mode: privacyMode } = resolvePrivacyMode(db);
        const redaction = redactText(patch.text, privacyMode);

        if (privacyMode === "strict" && redaction.blocked) {
          // Recorded OUTSIDE the write transaction, same shape as
          // remember()'s strict-mode refusal above.
          recordRedactions(
            db,
            redaction.findings.map((finding) => ({
              memoryId: id,
              episodeId: current?.episodeId ?? null,
              scope: current?.scope ?? scope ?? null,
              sourceClient,
              kind: finding.kind,
              preview: finding.preview,
              action: "blocked",
            })),
          );
          // Same message shape as remember()'s refusal (and the same
          // prefix): src/dashboard/api.ts's isStrictRedactionRefusal
          // matches on it to answer this as a refusal rather than a 500.
          throw new Error(
            `remember refused: found ${summarizeFindings(redaction.findings)}; privacy mode is "strict"`,
          );
        }

        textToStore = redaction.text;
        findings = redaction.findings;
      }

      // Invariant: the mutation, any redaction rows, and the audit row
      // commit together or not at all -- a failure partway through must not
      // leave a mutated store with no trace of it in the §5 access log, or
      // a redacted memory whose finding was never recorded.
      return db.tx(() => {
        let memory = updateMemory(db, id, { ...patch, text: textToStore });
        if (findings.length > 0) {
          // updateMemory (repositories/memories.ts) has no `redacted`
          // column support; set it directly here, same pattern as
          // importMemory's own direct UPDATE below.
          db.q(`UPDATE memories SET redacted = 1 WHERE id = ?`).run(memory.id);
          memory = getMemory(db, memory.id) ?? memory;
          recordRedactions(
            db,
            findings.map((finding) => ({
              memoryId: memory.id,
              episodeId: memory.episodeId,
              scope: memory.scope,
              sourceClient,
              kind: finding.kind,
              preview: finding.preview,
              action: "redacted",
            })),
          );
        }
        recordAudit(db, {
          action: "update_memory",
          memoryId: memory.id,
          scope: memory.scope ?? scope ?? null,
          sourceClient,
        });
        return memory;
      });
    },

    forget(id, ctx) {
      requireWritable("forget");
      const { sourceClient, scope } = gate(ctx, "forget");
      // Invariant: the mutation and its audit row commit together or not
      // at all -- a failed audit insert must not leave a mutated store
      // with no trace of it in the §5 access log.
      return db.tx(() => {
        const memory = getMemory(db, id);
        const ok = softDeleteMemory(db, id);
        if (ok) {
          markEpisodeForgotten(db, memory?.episodeId, true);
        }
        recordAudit(db, {
          action: "forget",
          memoryId: id,
          scope: memory?.scope ?? scope ?? null,
          sourceClient,
          resultCount: ok ? 1 : 0,
        });
        return ok;
      });
    },

    async forgetWhere(query, options, ctx) {
      const confirm = options.confirm === true;
      if (confirm) requireWritable("forgetWhere");
      const { sourceClient, scope } = gate(ctx, confirm ? "forget" : "list_memories");
      const effectiveScope = options.scope ?? scope;
      const limit = clampLimit(options.limit);
      // Deliberately does NOT inherit search()'s default relevance/distance
      // floors (DEFAULT_MIN_RELEVANCE / DEFAULT_MAX_VECTOR_DISTANCE in
      // ../retrieval/search.ts): those floors are tuned for injecting
      // memories into a prompt (get_context), where a marginal match is
      // noise and should be dropped. A query-shaped delete wants the
      // opposite -- "forget everything about X" must show the user
      // everything that plausibly matches, not silently hide a candidate
      // the floor happened to score near 0. This is safe specifically
      // because forgetWhere is preview-then-confirm: the human sees the
      // full match list here and decides, so being generous costs nothing,
      // while being stingy would hide matches the user asked for and never
      // knows were dropped. Do not "align" this with get_context's floors --
      // the two callers want opposite things on purpose.
      const result = await search(
        db,
        query,
        { scope: effectiveScope, limit, minRelevance: 0, maxVectorDistance: 2 },
        retrievalDeps(undefined, undefined),
      );
      const matches = result.hits.map((hit) => ({ id: hit.id, text: hit.text, scope: hit.scope }));

      // Safety property: a query-shaped forget NEVER deletes without an
      // explicit confirm -- a model mis-firing this call must not silently
      // erase memories.
      if (!confirm) {
        if (!readOnly) {
          recordAudit(db, {
            action: "list_memories",
            scope: effectiveScope ?? null,
            sourceClient,
            query,
            resultCount: matches.length,
          });
        }
        return { deleted: false, count: 0, matches };
      }

      // Invariant: the mutation and its audit row commit together or not
      // at all -- a failed audit insert must not leave a mutated store
      // with no trace of it in the §5 access log.
      return db.tx(() => {
        const deletedMatches: typeof matches = [];
        for (const match of matches) {
          if (softDeleteMemory(db, match.id)) {
            deletedMatches.push(match);
            markEpisodeForgotten(db, getMemory(db, match.id)?.episodeId, true);
          }
        }
        recordAudit(db, {
          action: "forget",
          scope: effectiveScope ?? null,
          sourceClient,
          query,
          resultCount: deletedMatches.length,
        });
        return { deleted: deletedMatches.length > 0, count: deletedMatches.length, matches: deletedMatches };
      });
    },

    restore(id, ctx) {
      requireWritable("restore");
      const { sourceClient, scope } = gate(ctx, "restore");
      // Invariant: the mutation and its audit row commit together or not
      // at all -- a failed audit insert must not leave a mutated store
      // with no trace of it in the §5 access log.
      return db.tx(() => {
        const memory = getMemory(db, id);
        const ok = restoreMemory(db, id);
        if (ok) {
          markEpisodeForgotten(db, memory?.episodeId, false);
        }
        recordAudit(db, {
          action: "restore",
          memoryId: id,
          scope: memory?.scope ?? scope ?? null,
          sourceClient,
          resultCount: ok ? 1 : 0,
        });
        return ok;
      });
    },

    supersede(oldId, input, ctx) {
      requireWritable("supersede");
      assertContentWithinCap(input.text, "text");
      assertTagsWithinCap(input.tags);
      const { sourceClient, scope } = gate(ctx, "update_memory");

      // §10 redaction runs BEFORE anything is written, mirroring remember()
      // and update() above: supersede() writes a brand-new memory row from
      // input.text and skipped this entirely before this fix.
      const old = getMemory(db, oldId);
      const { mode: privacyMode } = resolvePrivacyMode(db);
      const redaction = redactText(input.text, privacyMode);

      if (privacyMode === "strict" && redaction.blocked) {
        // Recorded OUTSIDE the write transaction, same shape as remember()'s
        // and update()'s strict-mode refusal above.
        recordRedactions(
          db,
          redaction.findings.map((finding) => ({
            memoryId: oldId,
            episodeId: old?.episodeId ?? null,
            scope: old?.scope ?? scope ?? null,
            sourceClient,
            kind: finding.kind,
            preview: finding.preview,
            action: "blocked",
          })),
        );
        // Same message shape (and prefix) as remember()'s and update()'s
        // refusal: src/dashboard/api.ts's isStrictRedactionRefusal matches
        // on it to answer this as a refusal rather than a 500.
        throw new Error(
          `remember refused: found ${summarizeFindings(redaction.findings)}; privacy mode is "strict"`,
        );
      }

      const redacted = redaction.findings.length > 0;

      // Invariant: the mutation, any redaction rows, and the audit row
      // commit together or not at all -- a failure partway through must not
      // leave a mutated store with no trace of it in the §5 access log, or
      // a redacted memory whose finding was never recorded.
      return db.tx(() => {
        const result = supersedeMemory(db, oldId, {
          text: redaction.text,
          tags: input.tags,
          importance: input.importance,
          sourceClient,
          redacted,
        });
        if (redacted) {
          recordRedactions(
            db,
            redaction.findings.map((finding) => ({
              memoryId: result.replacement.id,
              episodeId: result.replacement.episodeId,
              scope: result.replacement.scope,
              sourceClient,
              kind: finding.kind,
              preview: finding.preview,
              action: "redacted",
            })),
          );
        }
        // No dedicated "supersede" action exists in the §6-capped audit
        // vocabulary; supersede replaces a memory's content (the old row is
        // marked superseded, a new one takes its place), which is closest
        // to update_memory, so it is recorded as that rather than widening
        // the union.
        recordAudit(db, {
          action: "update_memory",
          memoryId: oldId,
          scope: result.superseded.scope ?? scope ?? null,
          sourceClient,
          details: { supersededBy: result.replacement.id },
        });
        return result;
      });
    },

    asOf(at, options = {}, ctx) {
      // No dedicated action for a point-in-time browse; asOf is a read
      // like list, so it shares list_memories rather than widening the
      // §6-capped audit vocabulary.
      const { sourceClient, scope } = gate(ctx, "list_memories");
      const effectiveScope = options.scope ?? scope;
      const items = memoriesAsOf(db, at, { scope: effectiveScope, limit: options.limit });
      if (!readOnly) {
        recordAudit(db, {
          action: "list_memories",
          scope: effectiveScope ?? null,
          sourceClient,
          resultCount: items.length,
          details: { asOf: at },
        });
      }
      return items;
    },

    deleteEverything(options, ctx) {
      requireWritable("deleteEverything");
      // Safety property, same as forgetWhere's query-shaped delete: NEVER
      // purge without an explicit confirm -- a model mis-firing this call
      // must not silently erase the whole store.
      if (options.confirm !== true) {
        throw new Error(`deleteEverything refused: requires { confirm: true }`);
      }
      const { sourceClient, scope } = gate(ctx, "forget");
      // Invariant: the purge and its audit row commit together or not at
      // all -- a failed audit insert must not leave a purged store with no
      // trace of it in the §5 access log.
      const result = db.tx(() => {
        const memoryCount = db.q(`SELECT COUNT(*) AS c FROM memories`).get();
        const episodeCount = db.q(`SELECT COUNT(*) AS c FROM episodes`).get();
        const memories = memoryCount ? Number(memoryCount["c"]) : 0;
        const episodes = episodeCount ? Number(episodeCount["c"]) : 0;

        // Deliberately NOT purged: audit_log, clients, settings and
        // redactions. audit_log and redactions are the access log and the
        // privacy record that let a user verify the deletion happened at
        // all -- a "delete everything" that erased its own evidence would
        // be indistinguishable from data loss. clients and settings are
        // connection/config state, not stored memory content.
        let vectors = 0;
        if (db.capabilities.vectors) {
          for (const space of listVectorSpaces(db)) {
            const tableName = assertTableName(space.tableName);
            const countRow = db.q(`SELECT COUNT(*) AS c FROM ${tableName}`).get();
            vectors += countRow ? Number(countRow["c"]) : 0;
            db.exec(`DELETE FROM ${tableName}`);
          }
        }

        // Deleting from memories cascades to memory_tags (ON DELETE
        // CASCADE, PRAGMA foreign_keys=ON in db.ts) and fires memories_ad,
        // which cleans up memories_fts -- no separate FTS statement needed.
        db.q(`DELETE FROM memories`).run();
        db.q(`DELETE FROM episodes`).run();

        recordAudit(db, {
          action: "forget",
          scope: scope ?? null,
          sourceClient,
          details: { deleteEverything: true, memories, episodes, vectors },
        });

        return { memories, episodes, vectors };
      });
      // VACUUM cannot run inside a transaction, so it must be OUTSIDE
      // db.tx above -- and it runs only once the purge has actually
      // committed. secure_delete=ON (set on connection open below) already
      // overwrites freed pages, but §10 sells the .db as one copyable
      // artifact, and SQLite still leaves the freed pages themselves in the
      // file until VACUUM reclaims them; a failure here must not undo (it
      // cannot -- the purge already committed) or hide the purge result.
      //
      // The daemon runs in WAL mode and never closes its connection between
      // calls, so VACUUM's rewritten pages land in the -wal file, not the
      // main db file, and the PRE-vacuum pages (still carrying the deleted
      // plaintext) remain wherever they were checkpointed to -- measured:
      // the purged marker phrase was still present in BOTH cairn.db and
      // cairn.db-wal after VACUUM alone. `wal_checkpoint(TRUNCATE)`
      // immediately after folds the WAL back into the main file and then
      // truncates the WAL to zero bytes, which is what actually removes the
      // stale pages from both files in the state the daemon runs in. Kept
      // in this same best-effort try: the purge itself already committed by
      // this point, so a failure here can only mean the cleanup pass
      // (VACUUM and/or the checkpoint) did not fully run, never that the
      // purge is undone.
      try {
        db.exec("VACUUM");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // Best-effort: see the comment above.
      }
      return result;
    },

    importMemory(input, ctx) {
      requireWritable("importMemory");
      assertContentWithinCap(input.text, "text");
      assertTagsWithinCap(input.tags);
      assertScopeWithinCap(input.scope);
      const { sourceClient, scope } = gate(ctx, "import");
      const resolvedScope = input.scope ?? scope;
      const { episodeId, redacted: _claimedRedacted, ...repoInput } = input;

      // §10 redaction runs BEFORE anything is written, mirroring remember():
      // an archive is a file from anywhere, and import is exactly the
      // "ingest" path §10 requires this to run on. `input.redacted` (the
      // archive's own claim) is NEVER trusted -- destructured above and
      // discarded -- because a hostile archive could set it to true and
      // skip past a reviewer who trusts the flag, or set it to false with
      // no consequence; the flag actually stored is always re-derived from
      // what redactText finds here.
      const { mode: privacyMode } = resolvePrivacyMode(db);
      const redaction = redactText(input.text, privacyMode);

      if (privacyMode === "strict" && redaction.blocked) {
        recordRedactions(
          db,
          redaction.findings.map((finding) => ({
            memoryId: input.id,
            episodeId: episodeId ?? null,
            scope: resolvedScope ?? null,
            sourceClient,
            kind: finding.kind,
            preview: finding.preview,
            action: "blocked",
          })),
        );
        // Refuses the WHOLE import, not just this one line: importMemory is
        // called from inside archive.ts's own outer db.tx() (see
        // importArchive), so this throw unwinds and rolls back every line
        // already imported by this call, the same all-or-nothing guarantee
        // the import already makes for a malformed id or a bad checksum. An
        // import is one explicit, retryable user action -- unlike a stream
        // of remembers -- so failing the whole archive on one offending
        // line is the simpler, safer default; refusing only that line would
        // mean the import "half worked" with no single result to retry.
        throw new Error(
          `import refused: found ${summarizeFindings(redaction.findings)}; privacy mode is "strict"`,
        );
      }

      const redacted = redaction.findings.length > 0;

      // Invariant: the mutation, any redaction rows, and the audit row
      // commit together or not at all -- a failure partway through must not
      // leave a mutated store with no trace of it in the §5 access log, or
      // a redacted memory whose finding was never recorded.
      return db.tx(() => {
        let result = importMemoryRepo(db, { ...repoInput, text: redaction.text, scope: resolvedScope, redacted });
        // See the episodeId doc comment on the Store interface above: wired
        // up only when the reference resolves in THIS store, exactly like
        // importMemoryRepo already does for supersededBy, and never on a
        // skip -- there is no row to attach it to.
        if (!result.skipped && episodeId) {
          const target = db.q(`SELECT id FROM episodes WHERE id = ?`).get(episodeId);
          if (target) {
            db.q(`UPDATE memories SET episode_id = ? WHERE id = ?`).run(episodeId, input.id);
            result = { ...result, memory: getMemory(db, input.id) };
          }
        }
        if (!result.skipped && redacted && result.memory) {
          recordRedactions(
            db,
            redaction.findings.map((finding) => ({
              memoryId: result.memory?.id ?? input.id,
              episodeId: result.memory?.episodeId ?? null,
              scope: result.memory?.scope ?? resolvedScope ?? null,
              sourceClient,
              kind: finding.kind,
              preview: finding.preview,
              action: "redacted",
            })),
          );
        }
        recordAudit(db, {
          action: "import",
          memoryId: result.memory?.id ?? input.id,
          scope: result.memory?.scope ?? resolvedScope ?? null,
          sourceClient,
          details: { skipped: result.skipped, reason: result.reason ?? null },
        });
        return result;
      });
    },

    importEpisode(input, ctx) {
      requireWritable("importEpisode");
      assertContentWithinCap(input.content, "content");
      assertScopeWithinCap(input.scope);
      assertMetadataWithinCap(input.metadata);
      const { sourceClient, scope } = gate(ctx, "import");
      const resolvedScope = input.scope ?? scope;

      // §10 redaction runs BEFORE anything is written, same reasoning as
      // importMemory above -- an episode's content is just as much an
      // ingest path as a memory's text is, and so is its metadata (see
      // assertMetadataWithinCap's comment above: this is the fifth path).
      const { mode: privacyMode } = resolvePrivacyMode(db);
      const redaction = redactText(input.content, privacyMode);
      const metadataRedaction = redactMetadata(input.metadata, privacyMode);

      if (privacyMode === "strict" && (redaction.blocked || metadataRedaction.blocked)) {
        const findings = [...redaction.findings, ...metadataRedaction.findings];
        recordRedactions(
          db,
          findings.map((finding) => ({
            memoryId: null,
            episodeId: input.id,
            scope: resolvedScope ?? null,
            sourceClient,
            kind: finding.kind,
            preview: finding.preview,
            action: "blocked",
          })),
        );
        // Same all-or-nothing reasoning as importMemory's own strict refusal
        // above -- this throw unwinds archive.ts's outer db.tx() too.
        throw new Error(
          `import refused: found ${summarizeFindings(findings)}; privacy mode is "strict"`,
        );
      }

      const redacted = redaction.findings.length > 0 || metadataRedaction.findings.length > 0;

      // Invariant: the mutation, any redaction rows, and the audit row
      // commit together or not at all -- see importMemory's own comment
      // above.
      return db.tx(() => {
        const result = importEpisodeRepo(db, {
          ...input,
          content: redaction.text,
          scope: resolvedScope,
          metadata: metadataRedaction.metadata,
        });
        if (!result.skipped && redacted && result.episode) {
          recordRedactions(
            db,
            [...redaction.findings, ...metadataRedaction.findings].map((finding) => ({
              memoryId: null,
              episodeId: result.episode?.id ?? input.id,
              scope: result.episode?.scope ?? resolvedScope ?? null,
              sourceClient,
              kind: finding.kind,
              preview: finding.preview,
              action: "redacted",
            })),
          );
        }
        recordAudit(db, {
          action: "import",
          scope: result.episode?.scope ?? resolvedScope ?? null,
          sourceClient,
          details: { skipped: result.skipped, reason: result.reason ?? null, episodeId: input.id },
        });
        return result;
      });
    },

    episodes(options = {}, ctx) {
      // No dedicated action for browsing the episodic log; episodes() is a
      // read like list, so it shares list_memories rather than widening
      // the §6-capped audit vocabulary.
      const { sourceClient, scope } = gate(ctx, "list_memories");
      const effectiveScope = options.scope ?? scope;
      const limit = clampLimit(options.limit);
      const { includeDeleted } = options;

      // See MAX_FORGOTTEN_SCAN_PAGES's comment above: page underneath until
      // this page is full or the underlying cursor runs out, bounded so a
      // store full of forgotten episodes cannot turn this into a full scan.
      const collected: Episode[] = [];
      let cursor = options.cursor ?? null;
      let underlyingExhausted = false;
      for (let page = 0; page < MAX_FORGOTTEN_SCAN_PAGES; page++) {
        const result = listEpisodes(db, { scope: effectiveScope, cursor, limit });
        // §10: a forgotten memory's provenance episode must not be readable
        // by default, same as the forgotten memory itself -- see
        // markEpisodeForgotten's doc comment above.
        const visible = includeDeleted ? result.items : result.items.filter((e) => !isEpisodeForgotten(e));
        collected.push(...visible);
        cursor = result.nextCursor;
        if (cursor === null) {
          underlyingExhausted = true;
          break;
        }
        if (collected.length >= limit) break;
      }

      const items = collected.slice(0, limit);
      let nextCursor: string | null;
      if (items.length < collected.length) {
        // The last underlying page contributed more visible rows than this
        // page needed: resume right after the last row actually returned,
        // not the underlying cursor (which points past the extra rows we
        // dropped here) -- otherwise those extra rows would be skipped
        // forever on the next call.
        const last = items[items.length - 1];
        nextCursor = last ? encodeCursor(last.createdAt, last.id) : cursor;
      } else if (!underlyingExhausted) {
        nextCursor = cursor;
      } else {
        nextCursor = null;
      }

      if (!readOnly) {
        recordAudit(db, {
          action: "list_memories",
          scope: effectiveScope ?? null,
          sourceClient,
          resultCount: items.length,
        });
      }
      return { items, nextCursor };
    },

    episode(id, ctx, options = {}) {
      const { sourceClient, scope } = gate(ctx, "list_memories");
      const item = getEpisode(db, id);
      // See episodes() above -- same default-hidden rule.
      const visible = item && (options.includeDeleted || !isEpisodeForgotten(item)) ? item : undefined;
      if (!readOnly) {
        recordAudit(db, {
          action: "list_memories",
          memoryId: null,
          scope: scope ?? null,
          sourceClient,
          resultCount: visible ? 1 : 0,
        });
      }
      return visible;
    },

    auditLog(options) {
      return listAudit(db, options);
    },

    clientStats(options) {
      return countAuditByClient(db, options);
    },

    clients() {
      return listClients(db);
    },

    setClientEnabled(id, enabled, ctx) {
      requireWritable("setClientEnabled");
      // Invariant: the mutation and its audit row commit together or not
      // at all -- a failed audit insert must not leave a client paused (or
      // resumed) with no trace of it in the §5 access log.
      return db.tx(() => {
        const client = setClientEnabledRepo(db, id, enabled);
        recordAudit(db, {
          action: "client_enabled",
          sourceClient: ctx?.sourceClient ?? null,
          details: { id, enabled },
        });
        return client;
      });
    },

    privacy() {
      return resolvePrivacyMode(db);
    },

    setPrivacy(mode, ctx) {
      requireWritable("setPrivacy");
      // Invariant: the mutation and its audit row commit together or not
      // at all -- a failed audit insert must not leave redaction switched
      // with no trace of it in the §5 access log.
      return db.tx(() => {
        // Resolve BEFORE writing: env beats settings (see
        // privacy-settings.ts), so if the env var is what's actually in
        // effect, persisting `mode` into settings would silently contradict
        // it the moment the daemon restarts without that env var -- exactly
        // the dashboard's own "cannot override an environment variable"
        // promise. Still audited either way, with the requested value
        // preserved, so the attempt is findable in the access log.
        const before = resolvePrivacyMode(db);
        let config: PrivacyConfig;
        if (before.source === "env") {
          config = before;
        } else {
          setPrivacyMode(db, mode);
          config = resolvePrivacyMode(db);
        }
        recordAudit(db, {
          action: "privacy_mode",
          sourceClient: ctx?.sourceClient ?? null,
          details: { requested: mode, effective: config.mode, source: config.source },
        });
        return config;
      });
    },

    redactions(options) {
      return listRedactions(db, options);
    },

    redactionStats(options) {
      return countRedactionsByKind(db, options);
    },

    close() {
      db.close();
    },
  };
}
