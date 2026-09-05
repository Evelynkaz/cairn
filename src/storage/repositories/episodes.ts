// The append-only episodic log of BUILD_BRIEF §5: the source is never
// destroyed, so this repository has no update and no delete.

import type { CairnDb } from "../db.js";
import type { Row, SqlValue } from "../driver/index.js";
import { DEFAULT_SCOPE } from "../types.js";
import type { Episode } from "../types.js";
import { timestampFromUuidv7, uuidv7 } from "../../util/id.js";
import { json, num, str, strOrNull } from "./row.js";
import { clampLimit, decodeCursor, encodeCursor } from "./paging.js";

// Bounds how much of an attacker-controlled value (an archive's episode id,
// or any other field) can ever land in an error message: these errors can
// surface all the way into an MCP client's context (BUILD_BRIEF §12).
// Mirrors src/storage/repositories/memories.ts's safeValue() -- same
// approach, kept local here rather than shared, per that module's comment.
function safeValue(value: unknown): string {
  return JSON.stringify(String(value).slice(0, 80));
}

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

// Shared by appendEpisode and importEpisode below -- the append path's only
// side effect is this one INSERT (there is no FTS trigger on episodes, and
// no tags to replace), so import reuses it rather than writing a parallel
// insert that could drift from it.
function insertEpisode(
  db: CairnDb,
  id: string,
  content: string,
  scope: string,
  sourceClient: string | null,
  metadata: Record<string, unknown>,
  createdAt: number,
): void {
  db.q(
    `INSERT INTO episodes (id, content, scope, source_client, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, content, scope, sourceClient, JSON.stringify(metadata), createdAt);
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

  insertEpisode(db, id, input.content, scope, sourceClient, metadata, createdAt);

  return { id, content: input.content, scope, sourceClient, metadata, createdAt };
}

export type ImportEpisodeSkipReason = "duplicate-id";

export interface ImportEpisodeResult {
  episode: Episode | undefined;
  skipped: boolean;
  reason?: ImportEpisodeSkipReason;
}

// Earliest created_at we accept from an id's embedded timestamp -- same
// reasoning and same value as memories.ts's EARLIEST_SANE_TIMESTAMP: uuidv7
// as a format predates this codebase, so nothing genuinely exported from a
// Cairn store can claim to be older than this project.
const EARLIEST_SANE_TIMESTAMP = Date.UTC(2020, 0, 1);

// How far into the future an id's embedded timestamp may sit before it is
// refused rather than a wildly implausible one (e.g. a hand-edited archive
// carrying a year-9999 id) permanently outranking every real memory in
// every recency-weighted list, including get_context's output. Five minutes
// is generous enough to absorb ordinary clock drift between two machines,
// nowhere near enough to matter for ranking, and far short of a genuinely
// bogus future timestamp.
//
// TWIN: this predicate (EARLIEST_SANE_TIMESTAMP + FUTURE_SKEW_MS bound) is
// duplicated in memories.ts's importMemory. The two must move together --
// this codebase has already been bitten once (bd8f75b) by a duplicated
// predicate drifting apart.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

// Import-only insertion: an episode that already has an id (minted by the
// EXPORTING store's uuidv7()) rather than one minted fresh here. This is
// deliberately NOT "call appendEpisode but pass an id through" --
// appendEpisode derives created_at from a freshly-minted id, which is
// exactly wrong for import. created_at must be derived from the ORIGINAL
// id, or every imported episode's creation time collapses to "now" and the
// chronology that "take your memory with you" (BUILD_BRIEF §1) exists to
// preserve is destroyed. So this function re-derives createdAt from
// input.id itself (never trusting a createdAt field carried in the
// archive), and otherwise reuses exactly the same side effect appendEpisode
// relies on: insertEpisode above.
export function importEpisode(
  db: CairnDb,
  input: {
    id: string;
    content: string;
    scope?: string;
    sourceClient?: string | null;
    metadata?: Record<string, unknown>;
  },
): ImportEpisodeResult {
  // Validate the id itself: a malformed id (from a hand-edited archive)
  // must be refused, not stored, or created_at becomes nonsense.
  // timestampFromUuidv7 already rejects anything that isn't a canonical
  // UUIDv7; the range check below additionally catches a well-formed
  // UUIDv7 whose embedded timestamp is not plausibly a real export.
  const createdAt = timestampFromUuidv7(input.id);
  const now = Date.now();
  if (createdAt < EARLIEST_SANE_TIMESTAMP || createdAt > now + FUTURE_SKEW_MS) {
    throw new Error(`episode ${safeValue(input.id)}: id does not embed a plausible timestamp (${createdAt})`);
  }

  const scope = input.scope ?? DEFAULT_SCOPE;
  const sourceClient = input.sourceClient ?? null;
  const metadata = input.metadata ?? {};

  return db.tx(() => {
    // Never overwrite: re-importing the same archive twice must be a
    // no-op the second time.
    const existing = db.q(`SELECT id FROM episodes WHERE id = ?`).get(input.id);
    if (existing) {
      return { episode: undefined, skipped: true, reason: "duplicate-id" };
    }

    insertEpisode(db, input.id, input.content, scope, sourceClient, metadata, createdAt);
    const episode = getEpisode(db, input.id);
    if (!episode) {
      throw new Error(`episode ${safeValue(input.id)} not found immediately after import insert`);
    }
    return { episode, skipped: false };
  });
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
