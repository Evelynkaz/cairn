// The append-only episodic log of BUILD_BRIEF §5: the source is never
// destroyed, so this repository has no update and no delete.

import type { CairnDb } from "../db.js";
import type { Row, SqlValue } from "../driver/index.js";
import { DEFAULT_SCOPE } from "../types.js";
import type { Episode } from "../types.js";
import { timestampFromUuidv7, uuidv7 } from "../../util/id.js";
import { json, num, str, strOrNull } from "./row.js";
import { clampLimit, decodeCursor, encodeCursor } from "./paging.js";

function rowToEpisode(row: Row): Episode {
  return {
    id: str(row, "id"),
    content: str(row, "content"),
    scope: str(row, "scope"),
    sourceClient: strOrNull(row, "source_client"),
    metadata: json(row, "metadata"),
    createdAt: num(row, "created_at"),
  };
}

export function appendEpisode(
  db: CairnDb,
  input: {
    content: string;
    scope?: string;
    sourceClient?: string | null;
    metadata?: Record<string, unknown>;
  },
): Episode {
  const id = uuidv7();
  const createdAt = timestampFromUuidv7(id);
  const scope = input.scope ?? DEFAULT_SCOPE;
  const sourceClient = input.sourceClient ?? null;
  const metadata = input.metadata ?? {};

  db.q(
    `INSERT INTO episodes (id, content, scope, source_client, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.content, scope, sourceClient, JSON.stringify(metadata), createdAt);

  return { id, content: input.content, scope, sourceClient, metadata, createdAt };
}

export function getEpisode(db: CairnDb, id: string): Episode | undefined {
  const row = db
    .q(`SELECT id, content, scope, source_client, metadata, created_at FROM episodes WHERE id = ?`)
    .get(id);
  return row ? rowToEpisode(row) : undefined;
}

export function listEpisodes(
  db: CairnDb,
  options: { scope?: string; limit?: number; cursor?: string | null } = {},
): { items: Episode[]; nextCursor: string | null } {
  const limit = clampLimit(options.limit);
  const conditions: string[] = [];
  const params: SqlValue[] = [];

  if (options.scope !== undefined) {
    conditions.push("scope = ?");
    params.push(options.scope);
  }
  if (options.cursor) {
    const { ts, id } = decodeCursor(options.cursor, "episodes");
    conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(ts, ts, id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .q(
      `SELECT id, content, scope, source_client, metadata, created_at FROM episodes
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...params, limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map(rowToEpisode);
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  return { items, nextCursor };
}
