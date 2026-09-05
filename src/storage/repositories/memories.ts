// Queryable facts layer of BUILD_BRIEF §5. `remember` never calls an LLM:
// dedupe here is pure content-hash lookup, no embedding required.

import type { CairnDb } from "../db.js";
import type { Row, SqlValue } from "../driver/index.js";
import { DEFAULT_SCOPE } from "../types.js";
import type { Memory } from "../types.js";
import { timestampFromUuidv7, uuidv7 } from "../../util/id.js";
import { contentHash } from "../../util/text.js";
import { bool, num, numOrNull, str, strOrNull } from "./row.js";
import { clampLimit, decodeCursor, encodeCursor } from "./paging.js";

// Thrown by updateMemory/supersedeMemory when the requested text would
// collide with another live memory's content_hash in the same scope. A
// typed error (not a message string) so a caller like the dashboard API can
// detect this structurally instead of pattern-matching a message meant for
// a human -- the message text itself remains free to change.
export class LiveTextCollisionError extends Error {
  readonly code = "live_text_collision";
  readonly conflictingId: string;
  constructor(message: string, conflictingId: string) {
    super(message);
    this.name = "LiveTextCollisionError";
    this.conflictingId = conflictingId;
  }
}

const MEMORY_COLUMNS =
  "id, seq, text, scope, source_client, importance, created_at, updated_at, " +
  "last_accessed, access_count, valid_from, valid_until, superseded_by, " +
  "episode_id, deleted_at, redacted, content_hash";

// BUILD_BRIEF §6/§5: importance is 0-1 on the MCP surface. A bare CHECK
// constraint failure is opaque, so reject out-of-range values here with a
// message that names the offending value.
function checkImportance(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`importance must be between 0 and 1, got ${value}`);
  }
}

function uniqueSorted(tags: string[]): string[] {
  return Array.from(new Set(tags)).sort();
}

function rowToMemory(row: Row, tags: string[]): Memory {
  return {
    id: str(row, "id"),
    seq: num(row, "seq"),
    text: str(row, "text"),
    scope: str(row, "scope"),
    sourceClient: strOrNull(row, "source_client"),
    importance: num(row, "importance"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
    lastAccessed: numOrNull(row, "last_accessed"),
    accessCount: num(row, "access_count"),
    validFrom: num(row, "valid_from"),
    validUntil: numOrNull(row, "valid_until"),
    supersededBy: strOrNull(row, "superseded_by"),
    episodeId: strOrNull(row, "episode_id"),
    deletedAt: numOrNull(row, "deleted_at"),
    redacted: bool(row, "redacted"),
    contentHash: str(row, "content_hash"),
    tags,
  };
}

function fetchTags(db: CairnDb, memoryId: string): string[] {
  const rows = db.q(`SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag`).all(memoryId);
  return rows.map((row) => str(row, "tag"));
}

function replaceTags(db: CairnDb, memoryId: string, tags: string[]): void {
  db.q(`DELETE FROM memory_tags WHERE memory_id = ?`).run(memoryId);
  const stmt = db.q(`INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)`);
  for (const tag of tags) {
    stmt.run(memoryId, tag);
  }
}

export function getMemory(db: CairnDb, id: string): Memory | undefined {
  const row = db.q(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`).get(id);
  if (!row) return undefined;
  return rowToMemory(row, fetchTags(db, id));
}

export function createMemory(
  db: CairnDb,
  input: {
    text: string;
    scope?: string;
    tags?: string[];
    sourceClient?: string | null;
    importance?: number;
    episodeId?: string | null;
    redacted?: boolean;
  },
): { memory: Memory; deduped: boolean } {
  checkImportance(input.importance);
  const scope = input.scope ?? DEFAULT_SCOPE;
  const tags = uniqueSorted(input.tags ?? []);
  const hash = contentHash(input.text);
  const importance = input.importance ?? 0.5;

  return db.tx(() => {
    // Dedupe lookup: this is the intended path for the partial unique
    // index idx_memories_live_hash. A UNIQUE violation escaping the INSERT
    // below means this lookup missed a live duplicate, which is a bug.
    const existing = db
      .q(`SELECT id FROM memories_live WHERE scope = ? AND content_hash = ?`)
      .get(scope, hash);

    if (existing) {
      const id = str(existing, "id");
      const current = getMemory(db, id);
      if (!current) {
        throw new Error(`memory ${id} found by dedupe lookup but missing from getMemory`);
      }
      const mergedTags = uniqueSorted([...current.tags, ...tags]);
      // Only merge when the caller actually supplied a value: defaulting
      // a missing importance to 0.5 before this point would silently
      // raise a fact the user deliberately marked low.
      const mergedImportance =
        input.importance === undefined ? current.importance : Math.max(current.importance, input.importance);
      const sets: string[] = ["updated_at = ?", "importance = ?"];
      const params: SqlValue[] = [Date.now(), mergedImportance];
      // Preserve provenance: attach the new write's episode when the
      // existing row has none, rather than dropping it silently.
      if (current.episodeId === null && input.episodeId) {
        sets.push("episode_id = ?");
        params.push(input.episodeId);
      }
      params.push(id);
      db.q(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      replaceTags(db, id, mergedTags);
      const memory = getMemory(db, id);
      if (!memory) {
        throw new Error(`memory ${id} vanished after dedupe update`);
      }
      return { memory, deduped: true };
    }

    const id = uuidv7();
    const createdAt = timestampFromUuidv7(id);
    db.q(
      `INSERT INTO memories
         (id, text, scope, source_client, importance, created_at, updated_at,
          valid_from, episode_id, redacted, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.text,
      scope,
      input.sourceClient ?? null,
      importance,
      createdAt,
      createdAt,
      createdAt,
      input.episodeId ?? null,
      input.redacted ? 1 : 0,
      hash,
    );
    replaceTags(db, id, tags);
    const memory = getMemory(db, id);
    if (!memory) {
      throw new Error(`memory ${id} not found immediately after insert`);
    }
    return { memory, deduped: false };
  });
}

export type ImportMemorySkipReason = "duplicate-id" | "duplicate-content";

export interface ImportMemoryResult {
  memory: Memory | undefined;
  skipped: boolean;
  reason?: ImportMemorySkipReason;
}

// Earliest created_at we accept from an id's embedded timestamp: uuidv7 as
// a format predates this codebase, but nothing genuinely exported from a
// Cairn store can claim to be older than this project. A hand-edited or
// corrupted archive id that decodes to a wildly implausible timestamp is
// refused rather than stored, per the id-validation requirement below.
const EARLIEST_SANE_TIMESTAMP = Date.UTC(2020, 0, 1);

// How far into the future an id's embedded timestamp may sit before it is
// refused rather than a wildly implausible one (e.g. a hand-edited archive
// carrying a year-9999 id) permanently outranking every real memory in
// every recency-weighted list, including get_context's output. Five minutes
// is generous enough to absorb ordinary clock drift between two machines,
// nowhere near enough to matter for ranking, and far short of a genuinely
// bogus future timestamp.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

// Import-only insertion: a memory that already has an id (minted by the
// EXPORTING store's uuidv7()) rather than one minted fresh here. This is
// deliberately NOT "call createMemory but pass an id through" -- createMemory
// derives created_at from a freshly-minted id, which is exactly wrong for
// import. created_at must be derived from the ORIGINAL id, or every
// imported memory's creation time collapses to "now" and the chronology
// that "take your memory with you" (BUILD_BRIEF §1) exists to preserve is
// destroyed. So this function re-derives createdAt from input.id itself
// (never trusting a createdAt field carried in the archive), and otherwise
// reuses exactly the same side effects createMemory relies on: the FTS
// trigger fires off the same INSERT INTO memories, tags go through the same
// replaceTags, and the same idx_memories_live_hash dedupe rule applies.
export function importMemory(
  db: CairnDb,
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
  },
): ImportMemoryResult {
  checkImportance(input.importance);

  // Validate the id itself: a malformed id (from a hand-edited archive)
  // must be refused, not stored, or created_at becomes nonsense.
  // timestampFromUuidv7 already rejects anything that isn't a canonical
  // UUIDv7; the range check below additionally catches a well-formed
  // UUIDv7 whose embedded timestamp is not plausibly a real export.
  const createdAt = timestampFromUuidv7(input.id);
  const now = Date.now();
  if (createdAt < EARLIEST_SANE_TIMESTAMP || createdAt > now + FUTURE_SKEW_MS) {
    throw new Error(`memory ${input.id}: id does not embed a plausible timestamp (${createdAt})`);
  }

  const scope = input.scope ?? DEFAULT_SCOPE;
  const tags = uniqueSorted(input.tags ?? []);
  const hash = contentHash(input.text);
  const importance = input.importance ?? 0.5;

  return db.tx(() => {
    // Never overwrite: re-importing the same archive twice must be a
    // no-op the second time.
    const existingById = db.q(`SELECT id FROM memories WHERE id = ?`).get(input.id);
    if (existingById) {
      return { memory: undefined, skipped: true, reason: "duplicate-id" };
    }

    // Same live-hash rule createMemory enforces via idx_memories_live_hash:
    // an imported memory whose text is already live in this scope is
    // skipped, not duplicated, rather than bypassing the constraint.
    const liveConflict = db
      .q(`SELECT id FROM memories_live WHERE scope = ? AND content_hash = ?`)
      .get(scope, hash);
    if (liveConflict) {
      return { memory: undefined, skipped: true, reason: "duplicate-content" };
    }

    const updatedAt = input.updatedAt ?? createdAt;
    const validFrom = input.validFrom ?? createdAt;

    db.q(
      `INSERT INTO memories
         (id, text, scope, source_client, importance, created_at, updated_at,
          valid_from, valid_until, deleted_at, redacted, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.text,
      scope,
      input.sourceClient ?? null,
      importance,
      createdAt,
      updatedAt,
      validFrom,
      input.validUntil ?? null,
      input.deletedAt ?? null,
      input.redacted ? 1 : 0,
      hash,
    );
    replaceTags(db, input.id, tags);

    // supersededBy is wired up only once the target already exists in this
    // store: the memories(id) foreign key requires the referenced row to
    // exist at the time it is set, and the archive may list a successor
    // after its predecessor, or a scope filter may have dropped the
    // successor from this archive entirely -- in that case this is
    // best-effort and left null rather than failing the whole import.
    if (input.supersededBy) {
      const target = db.q(`SELECT id FROM memories WHERE id = ?`).get(input.supersededBy);
      if (target) {
        db.q(`UPDATE memories SET superseded_by = ? WHERE id = ?`).run(input.supersededBy, input.id);
      }
    }

    const memory = getMemory(db, input.id);
    if (!memory) {
      throw new Error(`memory ${input.id} not found immediately after import insert`);
    }
    return { memory, skipped: false };
  });
}

export function listMemories(
  db: CairnDb,
  options: {
    scope?: string;
    tags?: string[];
    sourceClient?: string;
    // Filters on created_at, independent of the keyset cursor's own
    // (created_at, id) predicate below. `since` is inclusive, `until` is
    // exclusive -- i.e. `[since, until)` -- kept consistent with each other
    // so range filters compose without an off-by-one at either end.
    since?: number;
    until?: number;
    includeDeleted?: boolean;
    includeSuperseded?: boolean;
    limit?: number;
    cursor?: string | null;
  } = {},
): { items: Memory[]; nextCursor: string | null } {
  const limit = clampLimit(options.limit);
  const conditions: string[] = [];
  const params: SqlValue[] = [];

  if (!options.includeSuperseded) {
    conditions.push("valid_until IS NULL");
  }
  if (!options.includeDeleted) {
    conditions.push("deleted_at IS NULL");
  }
  if (options.scope !== undefined) {
    conditions.push("scope = ?");
    params.push(options.scope);
  }
  if (options.sourceClient !== undefined) {
    conditions.push("source_client = ?");
    params.push(options.sourceClient);
  }
  if (options.since !== undefined) {
    conditions.push("created_at >= ?");
    params.push(options.since);
  }
  if (options.until !== undefined) {
    conditions.push("created_at < ?");
    params.push(options.until);
  }
  // AND semantics: one EXISTS clause per requested tag. A fixed placeholder
  // per tag keeps this fragment simple, but note the resulting SQL text
  // (and therefore db.q's cache key) still varies with the NUMBER of tags
  // requested — that variable arity is expected and bounded by
  // STATEMENT_CACHE_LIMIT in db.ts, not something to special-case here.
  for (const tag of options.tags ?? []) {
    conditions.push(
      `EXISTS (SELECT 1 FROM memory_tags mt WHERE mt.memory_id = memories.id AND mt.tag = ?)`,
    );
    params.push(tag);
  }
  // Additional AND term, kept separate from the since/until range above:
  // the cursor compares the full (created_at, id) tuple against the last
  // row of the PREVIOUS page, which is a different comparison than a
  // caller-supplied created_at range and must not be merged with it or
  // collapsed into the same operator, or rows sharing a created_at at the
  // filter's boundary get skipped or repeated across pages.
  if (options.cursor) {
    const { ts, id } = decodeCursor(options.cursor, "memories");
    conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(ts, ts, id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .q(
      `SELECT ${MEMORY_COLUMNS} FROM memories
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...params, limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map((row) => rowToMemory(row, fetchTags(db, str(row, "id"))));
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  return { items, nextCursor };
}

export function updateMemory(
  db: CairnDb,
  id: string,
  patch: { text?: string; tags?: string[]; importance?: number },
): Memory {
  checkImportance(patch.importance);
  return db.tx(() => {
    const current = getMemory(db, id);
    if (!current) {
      throw new Error(`memory not found: ${id}`);
    }
    // §5 audit trail: a superseded row is history. Editing its text would
    // make memoriesAsOf(past) return content that was never actually live
    // at that time, silently falsifying the record.
    if (current.validUntil !== null) {
      throw new Error(`memory ${id} is superseded and cannot be edited`);
    }

    const sets: string[] = ["updated_at = ?"];
    const params: SqlValue[] = [Date.now()];

    if (patch.text !== undefined) {
      const hash = contentHash(patch.text);
      if (patch.text !== current.text) {
        const conflict = db
          .q(`SELECT id FROM memories_live WHERE scope = ? AND content_hash = ? AND id != ?`)
          .get(current.scope, hash, id);
        if (conflict) {
          const conflictId = str(conflict, "id");
          throw new LiveTextCollisionError(
            `text collides with live memory ${conflictId} in scope "${current.scope}"`,
            conflictId,
          );
        }
      }
      sets.push("text = ?", "content_hash = ?");
      params.push(patch.text, hash);
    }
    if (patch.importance !== undefined) {
      sets.push("importance = ?");
      params.push(patch.importance);
    }

    params.push(id);
    db.q(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params);

    if (patch.tags !== undefined) {
      replaceTags(db, id, uniqueSorted(patch.tags));
    }

    const updated = getMemory(db, id);
    if (!updated) {
      throw new Error(`memory ${id} vanished after update`);
    }
    return updated;
  });
}

export function softDeleteMemory(db: CairnDb, id: string): boolean {
  const result = db
    .q(`UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .run(Date.now(), id);
  return result.changes > 0;
}

export function restoreMemory(db: CairnDb, id: string): boolean {
  return db.tx(() => {
    const current = getMemory(db, id);
    if (!current || current.deletedAt === null) {
      return false;
    }
    // Restoring must be reversible even though dedupe only checks LIVE
    // rows on write: the text can legitimately have been re-remembered
    // (as a new row) while this one was deleted. Catch that here with a
    // named error instead of letting idx_memories_live_hash throw raw.
    const conflict = db
      .q(`SELECT id FROM memories_live WHERE scope = ? AND content_hash = ? AND id != ?`)
      .get(current.scope, current.contentHash, id);
    if (conflict) {
      const conflictId = str(conflict, "id");
      throw new LiveTextCollisionError(
        `cannot restore memory ${id}: its text is already live as memory ${conflictId}`,
        conflictId,
      );
    }
    const result = db
      .q(`UPDATE memories SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`)
      .run(id);
    return result.changes > 0;
  });
}

export function supersedeMemory(
  db: CairnDb,
  oldId: string,
  input: {
    text: string;
    scope?: string;
    tags?: string[];
    sourceClient?: string | null;
    importance?: number;
    episodeId?: string | null;
    redacted?: boolean;
  },
): { superseded: Memory; replacement: Memory } {
  checkImportance(input.importance);
  return db.tx(() => {
    const old = getMemory(db, oldId);
    if (!old) {
      throw new Error(`memory not found: ${oldId}`);
    }
    if (old.validUntil !== null || old.supersededBy !== null) {
      throw new Error(`memory ${oldId} is already superseded`);
    }

    const scope = input.scope ?? old.scope;
    const tags = uniqueSorted(input.tags ?? []);
    const hash = contentHash(input.text);
    const importance = input.importance ?? old.importance;

    // Same live-hash precheck updateMemory uses, but exclude the old row
    // itself: it is still live at this point, and restating its own text
    // to refresh it is the legitimate case, not a collision.
    const conflict = db
      .q(`SELECT id FROM memories_live WHERE scope = ? AND content_hash = ? AND id != ?`)
      .get(scope, hash, oldId);
    if (conflict) {
      const conflictId = str(conflict, "id");
      throw new LiveTextCollisionError(
        `text collides with live memory ${conflictId} in scope "${scope}"`,
        conflictId,
      );
    }

    const id = uuidv7();
    const createdAt = timestampFromUuidv7(id);
    // Invariant: a supersession interval must always be non-empty, because
    // a zero-width validity window (valid_until === valid_from) is
    // indistinguishable from "never existed" to memoriesAsOf, which
    // requires valid_from <= at AND (valid_until IS NULL OR valid_until >
    // at). uuidv7() mints both ids from Date.now(), so the replacement's
    // created_at collides with the old row's valid_from in the common
    // case (same millisecond); clamping to at least validFrom + 1 also
    // covers a backward clock step.
    const validUntil = Math.max(createdAt, old.validFrom + 1);

    // Set the old row's valid_until FIRST, before inserting the
    // replacement: idx_memories_live_hash is a partial unique index over
    // live rows, and the old row is still live until this UPDATE runs.
    // Inserting first would trip that index with a raw SQLite error
    // whenever the replacement's text collides with the old row's own
    // text (or with another live memory), instead of the checked error
    // above.
    db.q(`UPDATE memories SET valid_until = ? WHERE id = ?`).run(validUntil, oldId);

    db.q(
      `INSERT INTO memories
         (id, text, scope, source_client, importance, created_at, updated_at,
          valid_from, episode_id, redacted, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.text,
      scope,
      input.sourceClient ?? null,
      importance,
      createdAt,
      createdAt,
      createdAt,
      input.episodeId ?? null,
      input.redacted ? 1 : 0,
      hash,
    );
    replaceTags(db, id, tags);

    // Second update, now that the replacement row exists to satisfy the
    // superseded_by foreign key.
    db.q(`UPDATE memories SET superseded_by = ? WHERE id = ?`).run(id, oldId);

    const superseded = getMemory(db, oldId);
    const replacement = getMemory(db, id);
    if (!superseded || !replacement) {
      throw new Error(`supersede of ${oldId} failed to reload rows`);
    }
    return { superseded, replacement };
  });
}

// Feeds §7 recency/importance ranking. Deliberately does not touch
// `updated_at` or the `text` column: memories_au fires only on
// `UPDATE OF text`, so leaving text out of this statement keeps the FTS
// index untouched by every recall.
export function touchMemory(db: CairnDb, id: string): void {
  db.q(`UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?`).run(
    Date.now(),
    id,
  );
}

export function memoriesAsOf(
  db: CairnDb,
  at: number,
  options: { scope?: string; limit?: number } = {},
): Memory[] {
  const limit = clampLimit(options.limit);
  const conditions = ["valid_from <= ?", "(valid_until IS NULL OR valid_until > ?)", "deleted_at IS NULL"];
  const params: SqlValue[] = [at, at];

  if (options.scope !== undefined) {
    conditions.push("scope = ?");
    params.push(options.scope);
  }

  const rows = db
    .q(
      `SELECT ${MEMORY_COLUMNS} FROM memories
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...params, limit);

  return rows.map((row) => rowToMemory(row, fetchTags(db, str(row, "id"))));
}
