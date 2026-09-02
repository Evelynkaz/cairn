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

export function listMemories(
  db: CairnDb,
  options: {
    scope?: string;
    tags?: string[];
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
          throw new Error(
            `text collides with live memory ${str(conflict, "id")} in scope "${current.scope}"`,
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
      throw new Error(
        `cannot restore memory ${id}: its text is already live as memory ${str(conflict, "id")}`,
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
      throw new Error(`text collides with live memory ${str(conflict, "id")} in scope "${scope}"`);
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
