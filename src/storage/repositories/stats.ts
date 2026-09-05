// Bounded aggregates repository for the dashboard's stats panel
// (BUILD_BRIEF §9). Every field on StoreStats is a count or a short,
// explicitly-limited list -- never a page of memory content -- so this
// module returns numbers and small (scope, tag) pairs only.
//
// `memories_live` (deleted_at IS NULL AND valid_until IS NULL), not the
// base `memories` table, is the sanctioned source for anything asking
// "how many memories exist right now": see the comments at
// vectors.ts:269 and memories.ts:94. The base table is read here only for
// deletedMemories and supersededMemories, which by definition ask about
// rows the view excludes.

import type { CairnDb } from "../db.js";
import type { SqlValue } from "../driver/index.js";
import { num, numOrNull, str } from "./row.js";

const DEFAULT_TOP_LIMIT = 20;
const MAX_TOP_LIMIT = 100;
const DEFAULT_RECENT_ACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function clampTopLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_TOP_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_TOP_LIMIT);
}

export interface StoreStatsOptions {
  /** How many entries to return in each of the `topTags` / `scopes` lists. Values above 100 are clamped to 100; a value below 1 or non-finite falls back to the default of 20. */
  topLimit?: number;
  /** Cut-off for `recentActivity`; epoch ms. Defaults to 30 days before `now`. */
  since?: number;
  /** Injectable clock so tests are deterministic. Defaults to Date.now. */
  now?: () => number;
}

export interface StoreStats {
  /** Live memories: deleted_at IS NULL AND valid_until IS NULL. */
  liveMemories: number;
  /** Soft-deleted memories: deleted_at IS NOT NULL. */
  deletedMemories: number;
  /** Superseded memories: valid_until IS NOT NULL AND deleted_at IS NULL. */
  supersededMemories: number;
  /** Rows in `episodes`. */
  episodes: number;
  /** Live memories whose `redacted` flag is set. */
  redactedMemories: number;
  /** Distinct scopes over live memories, with a live count each, most memories first, then scope ASC. Bounded by topLimit. */
  scopes: Array<{ scope: string; count: number }>;
  /** Distinct tags over live memories, with a live count each, most memories first, then tag ASC. Bounded by topLimit. */
  topTags: Array<{ tag: string; count: number }>;
  /** createdAt of the oldest / newest live memory, or null when there are none. */
  oldestCreatedAt: number | null;
  newestCreatedAt: number | null;
  /** Live memories created at or after `since`. */
  recentActivity: number;
}

function count(db: CairnDb, sql: string, ...params: SqlValue[]): number {
  const row = db.q(sql).get(...params);
  return row ? num(row, "c") : 0;
}

export function memoryStats(db: CairnDb, options: StoreStatsOptions = {}): StoreStats {
  const topLimit = clampTopLimit(options.topLimit);
  const now = (options.now ?? Date.now)();
  const since = options.since ?? now - DEFAULT_RECENT_ACTIVITY_WINDOW_MS;

  const liveMemories = count(db, `SELECT COUNT(*) AS c FROM memories_live`);
  const deletedMemories = count(db, `SELECT COUNT(*) AS c FROM memories WHERE deleted_at IS NOT NULL`);
  const supersededMemories = count(
    db,
    `SELECT COUNT(*) AS c FROM memories WHERE valid_until IS NOT NULL AND deleted_at IS NULL`,
  );
  const episodes = count(db, `SELECT COUNT(*) AS c FROM episodes`);
  const redactedMemories = count(db, `SELECT COUNT(*) AS c FROM memories_live WHERE redacted = 1`);

  const scopeRows = db
    .q(
      `SELECT scope, COUNT(*) AS count FROM memories_live
       GROUP BY scope
       ORDER BY count DESC, scope ASC
       LIMIT ?`,
    )
    .all(topLimit);
  const scopes = scopeRows.map((row) => ({ scope: str(row, "scope"), count: numOrNull(row, "count") ?? 0 }));

  const tagRows = db
    .q(
      `SELECT t.tag AS tag, COUNT(*) AS count FROM memory_tags t
       JOIN memories_live m ON m.id = t.memory_id
       GROUP BY t.tag
       ORDER BY count DESC, tag ASC
       LIMIT ?`,
    )
    .all(topLimit);
  const topTags = tagRows.map((row) => ({ tag: str(row, "tag"), count: numOrNull(row, "count") ?? 0 }));

  const rangeRow = db
    .q(`SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM memories_live`)
    .get();
  const oldestCreatedAt = rangeRow ? numOrNull(rangeRow, "oldest") : null;
  const newestCreatedAt = rangeRow ? numOrNull(rangeRow, "newest") : null;

  const recentActivity = count(db, `SELECT COUNT(*) AS c FROM memories_live WHERE created_at >= ?`, since);

  return {
    liveMemories,
    deletedMemories,
    supersededMemories,
    episodes,
    redactedMemories,
    scopes,
    topTags,
    oldestCreatedAt,
    newestCreatedAt,
    recentActivity,
  };
}
