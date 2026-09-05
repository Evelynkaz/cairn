// "What's stored / what was blocked" repository (BUILD_BRIEF §9, §10).
// redactions deliberately has NO foreign key to memories (see the comment
// on that table in migrations/002-redactions.ts): the record must survive a
// hard purge of the memory it refers to, so a row can freely reference an
// id that no longer exists, or (for a blocked write) never existed. Do not
// "fix" that by adding a foreign key.
//
// `preview` must already be a masked excerpt by the time it reaches this
// module -- this repository does not mask anything itself, it only stores
// what the §10 redactor hands it. Never pass a raw secret as `preview`.

import type { CairnDb } from "../db.js";
import type { Row, SqlValue } from "../driver/index.js";
import type { RedactionAction, RedactionRecord } from "../types.js";
import { num, numOrNull, str, strOrNull } from "./row.js";
import { clampLimit, decodeCursor, encodeCursor } from "./paging.js";

export interface RedactionEntry {
  memoryId?: string | null;
  episodeId?: string | null;
  scope?: string | null;
  sourceClient?: string | null;
  kind: string;
  preview: string;
  action: RedactionAction;
}

// recordRedactions is called with everything the §10 redactor found for one
// write, not with an arbitrary caller-controlled batch -- this cap exists
// only to keep a single transaction bounded, well above any real write.
const MAX_RECORD_REDACTIONS = 500;

function toRedactionRecord(row: Row): RedactionRecord {
  return {
    id: num(row, "id"),
    ts: num(row, "ts"),
    memoryId: strOrNull(row, "memory_id"),
    episodeId: strOrNull(row, "episode_id"),
    scope: strOrNull(row, "scope"),
    sourceClient: strOrNull(row, "source_client"),
    kind: str(row, "kind"),
    preview: str(row, "preview"),
    action: str(row, "action") as RedactionAction,
  };
}

export function recordRedactions(db: CairnDb, entries: RedactionEntry[]): void {
  if (entries.length === 0) return;
  if (entries.length > MAX_RECORD_REDACTIONS) {
    throw new Error(`recordRedactions: ${entries.length} entries exceeds the ${MAX_RECORD_REDACTIONS} cap`);
  }
  const ts = Date.now();
  db.tx(() => {
    const insert = db.q(
      `INSERT INTO redactions (ts, memory_id, episode_id, scope, source_client, kind, preview, action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of entries) {
      insert.run(
        ts,
        entry.memoryId ?? null,
        entry.episodeId ?? null,
        entry.scope ?? null,
        entry.sourceClient ?? null,
        entry.kind,
        entry.preview,
        entry.action,
      );
    }
  });
}

export interface ListRedactionsOptions {
  action?: RedactionAction;
  memoryId?: string;
  since?: number;
  limit?: number;
  cursor?: string | null;
}

export interface ListRedactionsResult {
  items: RedactionRecord[];
  nextCursor: string | null;
}

export function listRedactions(db: CairnDb, options: ListRedactionsOptions = {}): ListRedactionsResult {
  const limit = clampLimit(options.limit);
  const conditions: string[] = [];
  const params: SqlValue[] = [];

  if (options.action !== undefined) {
    conditions.push("action = ?");
    params.push(options.action);
  }
  if (options.memoryId !== undefined) {
    conditions.push("memory_id = ?");
    params.push(options.memoryId);
  }
  if (options.since !== undefined) {
    conditions.push("ts >= ?");
    params.push(options.since);
  }
  if (options.cursor) {
    // Tuple comparison, not plain `ts < ?`: a burst of redactions from one
    // write routinely shares one millisecond (recordRedactions stamps them
    // all with the same ts), and a plain ts comparison skips or repeats
    // rows across pages when that happens.
    const { ts, id } = decodeCursor(options.cursor, "redactions");
    const cursorId = Number(id);
    if (!Number.isInteger(cursorId)) {
      throw new Error(`malformed redactions cursor: ${options.cursor}`);
    }
    conditions.push("(ts < ? OR (ts = ? AND id < ?))");
    params.push(ts, ts, cursorId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM redactions ${where} ORDER BY ts DESC, id DESC LIMIT ?`;
  const rows = db.q(sql).all(...params, limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(toRedactionRecord);
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.ts, String(last.id)) : null;

  return { items, nextCursor };
}

export interface RedactionKindCount {
  kind: string;
  action: string;
  count: number;
}

export function countRedactionsByKind(
  db: CairnDb,
  options: { since?: number; limit?: number } = {},
): RedactionKindCount[] {
  const limit = clampLimit(options.limit);
  const conditions: string[] = [];
  const params: SqlValue[] = [];
  if (options.since !== undefined) {
    conditions.push("ts >= ?");
    params.push(options.since);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT kind, action, COUNT(*) AS count
    FROM redactions
    ${where}
    GROUP BY kind, action
    ORDER BY count DESC, kind, action
    LIMIT ?
  `;
  const rows = db.q(sql).all(...params, limit);
  return rows.map((row) => ({
    kind: str(row, "kind"),
    action: str(row, "action"),
    count: numOrNull(row, "count") ?? 0,
  }));
}

export function deleteRedactionsForMemory(db: CairnDb, memoryId: string): number {
  const result = db.q("DELETE FROM redactions WHERE memory_id = ?").run(memoryId);
  return result.changes;
}
