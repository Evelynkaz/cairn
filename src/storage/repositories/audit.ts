// Access log + connected-clients repository (BUILD_BRIEF §9). audit_log
// deliberately has NO foreign key to memories (see the comment on that
// table in migrations/001-init.ts): the log must survive a hard purge of
// the memory it refers to, so a recorded event can freely reference an id
// that no longer exists, or never existed. Do not "fix" that by adding a
// foreign key, and never delete audit rows when a memory is deleted.
//
// `query` is a RECALL query, not ingest text, but the same reasoning
// applies: a user who searches for their own API key must not get it
// written to this log verbatim and rendered in the dashboard's access log.
// `recordAudit` below runs it through the §10 redactor before storing.
// `strict` is treated as `on` here -- refusing to log a search (as strict
// does on ingest) would be a strange failure mode for a read; recall
// already ran and returned a result, so the only question left is whether
// the LOGGED COPY of the query carries the secret, and `on`'s answer
// (mask it) is right regardless of ingest mode. `details` is for small
// structured metadata (counts, ids, flags) only — this module must never
// be given a place to stash raw memory content.

import type { CairnDb } from "../db.js";
import type { Row, SqlValue } from "../driver/index.js";
import type { AuditEvent, ClientRecord } from "../types.js";
import { redactText } from "../../privacy/index.js";
import { resolvePrivacyMode } from "../privacy-settings.js";
import { bool, num, numOrNull, str, strOrNull } from "./row.js";
import { clampLimit, decodeCursor, encodeCursor } from "./paging.js";

export type AuditAction =
  | "remember"
  | "recall"
  | "get_context"
  | "list_memories"
  | "update_memory"
  | "forget"
  | "restore"
  | "export"
  | "import";

// Single source of truth for the read/write split used by both
// countAuditByClient and the dashboard, so the two never drift apart.
export const AUDIT_READ_ACTIONS: readonly AuditAction[] = [
  "recall",
  "get_context",
  "list_memories",
  "export",
];
export const AUDIT_WRITE_ACTIONS: readonly AuditAction[] = [
  "remember",
  "update_memory",
  "forget",
  "restore",
  "import",
];

export interface RecordAuditEvent {
  action: AuditAction;
  memoryId?: string | null;
  scope?: string | null;
  sourceClient?: string | null;
  query?: string | null;
  resultCount?: number | null;
  details?: Record<string, unknown> | null;
  refused?: boolean;
}

// Parses the `details` TEXT column, naming the audit row on a corrupt
// value instead of letting a bare SyntaxError escape with no context.
function parseDetails(row: Row, auditId: number): Record<string, unknown> | null {
  const raw = strOrNull(row, "details");
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`audit row ${auditId}: column "details" has invalid JSON (${message})`, {
      cause: error,
    });
  }
}

function toAuditEvent(row: Row): AuditEvent {
  const id = num(row, "id");
  return {
    id,
    ts: num(row, "ts"),
    action: str(row, "action"),
    memoryId: strOrNull(row, "memory_id"),
    scope: strOrNull(row, "scope"),
    sourceClient: strOrNull(row, "source_client"),
    query: strOrNull(row, "query"),
    resultCount: numOrNull(row, "result_count"),
    details: parseDetails(row, id),
    refused: bool(row, "refused"),
  };
}

function toClientRecord(row: Row): ClientRecord {
  return {
    id: str(row, "id"),
    name: str(row, "name"),
    firstSeen: num(row, "first_seen"),
    lastSeen: num(row, "last_seen"),
    enabled: bool(row, "enabled"),
  };
}

// `strict` refuses a WRITE outright; there is no equivalent "refuse to log"
// action for a query string, so it is mapped to `on` (redact-and-store)
// here, per the module comment above.
function redactedQuery(db: CairnDb, query: string | null | undefined): string | null {
  if (query == null) return null;
  const { mode } = resolvePrivacyMode(db);
  if (mode === "off") return query;
  const effectiveMode = mode === "strict" ? "on" : mode;
  return redactText(query, effectiveMode).text;
}

export function recordAudit(db: CairnDb, event: RecordAuditEvent): number {
  const ts = Date.now();
  const details = event.details == null ? null : JSON.stringify(event.details);
  const result = db
    .q(
      `INSERT INTO audit_log (ts, action, memory_id, scope, source_client, query, result_count, details, refused)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ts,
      event.action,
      event.memoryId ?? null,
      event.scope ?? null,
      event.sourceClient ?? null,
      redactedQuery(db, event.query),
      event.resultCount ?? null,
      details,
      event.refused ? 1 : 0,
    );
  return result.lastInsertRowid;
}

export interface ListAuditOptions {
  action?: AuditAction;
  sourceClient?: string;
  memoryId?: string;
  since?: number;
  until?: number;
  limit?: number;
  cursor?: string | null;
  refused?: boolean;
}

export interface ListAuditResult {
  items: AuditEvent[];
  nextCursor: string | null;
}

export function listAudit(db: CairnDb, options: ListAuditOptions = {}): ListAuditResult {
  const limit = clampLimit(options.limit);
  const conditions: string[] = [];
  const params: SqlValue[] = [];

  if (options.action !== undefined) {
    conditions.push("action = ?");
    params.push(options.action);
  }
  if (options.sourceClient !== undefined) {
    conditions.push("source_client = ?");
    params.push(options.sourceClient);
  }
  if (options.memoryId !== undefined) {
    conditions.push("memory_id = ?");
    params.push(options.memoryId);
  }
  if (options.since !== undefined) {
    conditions.push("ts >= ?");
    params.push(options.since);
  }
  if (options.until !== undefined) {
    conditions.push("ts <= ?");
    params.push(options.until);
  }
  if (options.refused !== undefined) {
    conditions.push("refused = ?");
    params.push(options.refused ? 1 : 0);
  }
  if (options.cursor) {
    // Tuple comparison, not plain `ts < ?`: a burst of writes routinely
    // shares one millisecond, and a plain ts comparison skips or repeats
    // rows across pages when that happens.
    const { ts, id } = decodeCursor(options.cursor, "audit");
    const cursorId = Number(id);
    if (!Number.isInteger(cursorId)) {
      throw new Error(`malformed audit cursor: ${options.cursor}`);
    }
    conditions.push("(ts < ? OR (ts = ? AND id < ?))");
    params.push(ts, ts, cursorId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM audit_log ${where} ORDER BY ts DESC, id DESC LIMIT ?`;
  const rows = db.q(sql).all(...params, limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(toAuditEvent);
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.ts, String(last.id)) : null;

  return { items, nextCursor };
}

export interface ClientAuditCounts {
  sourceClient: string | null;
  reads: number;
  writes: number;
}

export function countAuditByClient(
  db: CairnDb,
  options: { since?: number; limit?: number } = {},
): ClientAuditCounts[] {
  const limit = clampLimit(options.limit);
  const readPlaceholders = AUDIT_READ_ACTIONS.map(() => "?").join(", ");
  const writePlaceholders = AUDIT_WRITE_ACTIONS.map(() => "?").join(", ");
  const params: SqlValue[] = [...AUDIT_READ_ACTIONS, ...AUDIT_WRITE_ACTIONS];

  // Refused rows (a paused client's blocked attempts) are excluded from
  // these counts, even though they stay in audit_log forever: the attempt
  // is evidence the user should see in the raw log, but it is not activity
  // the app actually performed, and counting it here would report a paused
  // app as busy -- the opposite of what pausing means.
  const conditions = ["refused = 0"];
  if (options.since !== undefined) {
    conditions.push("ts >= ?");
    params.push(options.since);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;

  // Ranked by total activity, not grouped straight to the client: the
  // grouping key is client-controlled free text (BUILD_BRIEF §13 bounded
  // output), so a session-per-run identifier must not be able to grow this
  // result without bound. Order in an outer query over the aliased totals
  // rather than repeating the CASE expressions in the ORDER BY.
  const sql = `
    SELECT source_client, reads, writes FROM (
      SELECT
        source_client,
        SUM(CASE WHEN action IN (${readPlaceholders}) THEN 1 ELSE 0 END) AS reads,
        SUM(CASE WHEN action IN (${writePlaceholders}) THEN 1 ELSE 0 END) AS writes
      FROM audit_log
      ${where}
      GROUP BY source_client
    )
    ORDER BY (writes + reads) DESC, source_client
    LIMIT ?
  `;
  const rows = db.q(sql).all(...params, limit);
  return rows.map((row) => ({
    sourceClient: strOrNull(row, "source_client"),
    reads: numOrNull(row, "reads") ?? 0,
    writes: numOrNull(row, "writes") ?? 0,
  }));
}

export function registerClient(db: CairnDb, id: string, name?: string): ClientRecord {
  const ts = Date.now();
  const clientName = name ?? id;
  // Upsert, not INSERT OR REPLACE: REPLACE deletes-then-inserts, resetting
  // first_seen (and, in the memories table's schema, orphaning related
  // rows). enabled is intentionally absent from the DO UPDATE SET clause:
  // a paused client that reconnects must stay paused.
  db.q(
    `INSERT INTO clients (id, name, first_seen, last_seen, enabled)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, name = excluded.name`,
  ).run(id, clientName, ts, ts);
  const client = getClient(db, id);
  if (!client) {
    throw new Error(`registerClient: failed to read back client ${id} after upsert`);
  }
  return client;
}

export function getClient(db: CairnDb, id: string): ClientRecord | undefined {
  const row = db.q("SELECT * FROM clients WHERE id = ?").get(id);
  return row ? toClientRecord(row) : undefined;
}

export function listClients(db: CairnDb, options: { limit?: number } = {}): ClientRecord[] {
  const limit = clampLimit(options.limit);
  return db
    .q("SELECT * FROM clients ORDER BY last_seen DESC, id ASC LIMIT ?")
    .all(limit)
    .map(toClientRecord);
}

export function setClientEnabled(db: CairnDb, id: string, enabled: boolean): ClientRecord {
  db.q("UPDATE clients SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  const client = getClient(db, id);
  if (!client) {
    throw new Error(`setClientEnabled: unknown client ${id}`);
  }
  return client;
}

export function isClientEnabled(db: CairnDb, id: string): boolean {
  const client = getClient(db, id);
  // Unknown is not disabled: a client that has never called registerClient
  // must not be silently blocked.
  return client ? client.enabled : true;
}
