// The single object the daemon, the CLI and the MCP tool layer all use.
// Composes the repositories and owns the three cross-cutting concerns none
// of them can own alone (BUILD_BRIEF §5, §9): episode provenance, audit
// trails, and per-client gating. No retrieval (recall/get_context, §7) and
// no embeddings live here — those are milestones 2 and 3.

import { openDb } from "./db.js";
import type { CairnDb, DbCapabilities } from "./db.js";
import type { DriverFactory } from "./driver/index.js";
import type { Memory, ClientRecord, Episode } from "./types.js";
import { appendEpisode, getEpisode, listEpisodes } from "./repositories/episodes.js";
import {
  createMemory,
  getMemory,
  listMemories,
  memoriesAsOf,
  restoreMemory,
  softDeleteMemory,
  supersedeMemory,
  touchMemory,
  updateMemory,
} from "./repositories/memories.js";
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

export interface StoreOptions {
  path?: string;
  driver?: DriverFactory;
  readOnly?: boolean;
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
      includeDeleted?: boolean;
      includeSuperseded?: boolean;
      limit?: number;
      cursor?: string | null;
    },
    ctx?: CallContext,
  ): { items: Memory[]; nextCursor: string | null };
  update(
    id: string,
    patch: { text?: string; tags?: string[]; importance?: number },
    ctx?: CallContext,
  ): Memory;
  forget(id: string, ctx?: CallContext): boolean;
  restore(id: string, ctx?: CallContext): boolean;
  supersede(
    oldId: string,
    input: { text: string; tags?: string[]; importance?: number },
    ctx?: CallContext,
  ): { superseded: Memory; replacement: Memory };
  asOf(at: number, options?: { scope?: string; limit?: number }, ctx?: CallContext): Memory[];

  episodes(
    options?: { scope?: string; limit?: number; cursor?: string | null },
    ctx?: CallContext,
  ): { items: Episode[]; nextCursor: string | null };
  episode(id: string, ctx?: CallContext): Episode | undefined;

  auditLog(options?: Parameters<typeof listAudit>[1]): ReturnType<typeof listAudit>;
  clientStats(options?: { since?: number; limit?: number }): ReturnType<typeof countAuditByClient>;
  clients(): ClientRecord[];
  setClientEnabled(id: string, enabled: boolean): ClientRecord;

  close(): void;
}

export function openStore(options: StoreOptions = {}): Store {
  const db = openDb({ path: options.path, driver: options.driver, readOnly: options.readOnly });
  const readOnly = options.readOnly ?? false;

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
      const { sourceClient, scope } = gate(ctx, "remember");
      const resolvedScope = input.scope ?? scope;

      return db.tx(() => {
        // Local-embedding hook lands in milestone 2 here: `remember` must
        // stay local-only and never make a network call in the default
        // path (BUILD_BRIEF §2). No vector is computed or stored yet.

        // The episodic log is append-only and keeps the source, so the
        // episode is appended even when the memory dedupes -- restating
        // something is itself history worth keeping.
        const episode = appendEpisode(db, {
          content: input.content,
          scope: resolvedScope,
          sourceClient,
          metadata: input.metadata,
        });
        const { memory, deduped } = createMemory(db, {
          text: input.content,
          scope: resolvedScope,
          tags: input.tags,
          sourceClient,
          importance: input.importance,
          episodeId: episode.id,
        });
        recordAudit(db, {
          action: "remember",
          memoryId: memory.id,
          scope: memory.scope,
          sourceClient,
          details: { deduped },
        });
        // See the episodeId doc comment on the Store interface for what
        // this value means on dedupe vs. a fresh write.
        return { memory, deduped, episodeId: memory.episodeId ?? episode.id };
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

    update(id, patch, ctx) {
      requireWritable("update");
      const { sourceClient, scope } = gate(ctx, "update_memory");
      // Invariant: the mutation and its audit row commit together or not
      // at all -- a failed audit insert must not leave a mutated store
      // with no trace of it in the §5 access log.
      return db.tx(() => {
        const memory = updateMemory(db, id, patch);
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

    restore(id, ctx) {
      requireWritable("restore");
      const { sourceClient, scope } = gate(ctx, "restore");
      // Invariant: the mutation and its audit row commit together or not
      // at all -- a failed audit insert must not leave a mutated store
      // with no trace of it in the §5 access log.
      return db.tx(() => {
        const memory = getMemory(db, id);
        const ok = restoreMemory(db, id);
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
      const { sourceClient, scope } = gate(ctx, "update_memory");
      // Invariant: the mutation and its audit row commit together or not
      // at all -- a failed audit insert must not leave a mutated store
      // with no trace of it in the §5 access log.
      return db.tx(() => {
        const result = supersedeMemory(db, oldId, {
          text: input.text,
          tags: input.tags,
          importance: input.importance,
          sourceClient,
        });
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

    episodes(options = {}, ctx) {
      // No dedicated action for browsing the episodic log; episodes() is a
      // read like list, so it shares list_memories rather than widening
      // the §6-capped audit vocabulary.
      const { sourceClient, scope } = gate(ctx, "list_memories");
      const effectiveScope = options.scope ?? scope;
      const result = listEpisodes(db, { ...options, scope: effectiveScope });
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

    episode(id, ctx) {
      const { sourceClient, scope } = gate(ctx, "list_memories");
      const item = getEpisode(db, id);
      if (!readOnly) {
        recordAudit(db, {
          action: "list_memories",
          memoryId: null,
          scope: scope ?? null,
          sourceClient,
          resultCount: item ? 1 : 0,
        });
      }
      return item;
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

    setClientEnabled(id, enabled) {
      requireWritable("setClientEnabled");
      return setClientEnabledRepo(db, id, enabled);
    },

    close() {
      db.close();
    },
  };
}
