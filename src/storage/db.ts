import { dirname } from "node:path";
import { getLoadablePath } from "sqlite-vec";
import { dbPath, ensureHome } from "../config/paths.js";
import { defaultDriver } from "./driver/index.js";
import type { DriverFactory, PreparedStatement, SqliteDriver } from "./driver/index.js";
import { migrations, runMigrations } from "./migrations/index.js";

export interface DbCapabilities {
  vectors: boolean;
  vectorError: string | null;
  journalMode: string | null;
}

export interface CairnDb {
  readonly path: string;
  readonly driverName: string;
  readonly capabilities: DbCapabilities;
  q(sql: string): PreparedStatement;
  exec(sql: string): void;
  tx<T>(fn: () => T): T;
  close(): void;
}

export interface OpenDbOptions {
  path?: string;
  driver?: DriverFactory;
  readOnly?: boolean;
}

function loadVectorExtension(driver: SqliteDriver): Pick<DbCapabilities, "vectors" | "vectorError"> {
  if (process.env["CAIRN_NO_VECTORS"] === "1") {
    return { vectors: false, vectorError: "disabled by CAIRN_NO_VECTORS" };
  }
  try {
    driver.loadExtension(getLoadablePath());
    return { vectors: true, vectorError: null };
  } catch (error) {
    // A database that cannot do semantic search must still open and serve
    // FTS. Nothing is printed here: stdout is reserved for the MCP stdio
    // transport, and the caller decides how to surface this via
    // `capabilities`.
    const message = error instanceof Error ? error.message : String(error);
    return { vectors: false, vectorError: message };
  }
}

function highestKnownVersion(): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

function currentUserVersion(driver: SqliteDriver): number {
  const row = driver.prepare("PRAGMA user_version").get();
  const value = row?.["user_version"];
  return typeof value === "number" ? value : Number(value);
}

// Round 3's variable-arity IN(?,?,?) tag filters and interpolated ORDER BY
// clauses each produce a distinct SQL string; an unbounded cache leaks
// memory for the life of the daemon (measured: 20 000 distinct statements
// ~= +189 MB RSS). Cap it with a simple LRU. Callers should still prefer
// fixed-arity SQL where practical.
const STATEMENT_CACHE_LIMIT = 200;

export function openDb(options: OpenDbOptions = {}): CairnDb {
  const path = options.path ?? dbPath();
  if (path !== ":memory:") {
    ensureHome(dirname(path));
  }

  const driverFactory = options.driver ?? defaultDriver;
  const readOnly = options.readOnly ?? false;
  const driver = driverFactory({ path, allowExtension: true, readOnly });

  try {
    // `PRAGMA journal_mode=WAL` does not throw when it cannot switch: it
    // silently returns the mode it actually settled on (e.g. `memory` for
    // an in-memory database, or `delete` on a filesystem with no
    // shared-memory support, such as some SMB/NFS mounts). The row it
    // returns must be read so the rest of this function -- and callers via
    // `capabilities.journalMode` -- know what mode is really in effect.
    let journalMode: string | null;
    if (!readOnly) {
      // WAL is a durability/concurrency choice for the single writer;
      // forcing it on a read-only connection throws "attempt to write a
      // readonly database" against a file that isn't already in WAL mode
      // (a restored backup, a file written by the sqlite3 CLI, a fresh
      // file opened read-only before any writer has touched it).
      const row = driver.prepare("PRAGMA journal_mode=WAL").get();
      const value = row?.["journal_mode"];
      journalMode = typeof value === "string" ? value : null;
    } else {
      const row = driver.prepare("PRAGMA journal_mode").get();
      const value = row?.["journal_mode"];
      journalMode = typeof value === "string" ? value : null;
    }
    driver.exec("PRAGMA busy_timeout=5000");
    driver.exec("PRAGMA foreign_keys=ON");
    // Without this, `INSERT OR REPLACE INTO memories` does not fire the
    // memories_ad delete trigger (SQLite only fires triggers for a
    // REPLACE-conflict delete when recursive_triggers is on), so the
    // external-content FTS5 index keeps stale terms after an upsert and
    // `integrity-check` still reports OK.
    driver.exec("PRAGMA recursive_triggers=ON");
    // synchronous=NORMAL is the correct durability trade-off only under WAL:
    // in rollback-journal mode it can lose the most recent commits on a
    // power loss, but under WAL a checkpoint failure just replays the WAL.
    // Applying NORMAL when journal_mode did not actually settle on `wal`
    // (see above) would trade away durability for nothing, so leave
    // SQLite's default FULL in that case.
    if (journalMode === "wal") {
      driver.exec("PRAGMA synchronous=NORMAL");
    }

    const capabilities: DbCapabilities = { ...loadVectorExtension(driver), journalMode };
    const highest = highestKnownVersion();

    if (readOnly) {
      const current = currentUserVersion(driver);
      if (current < highest) {
        throw new Error(
          `database at ${path} is at user_version ${current}, behind the ` +
            `required ${highest}, and cannot be migrated through a ` +
            `read-only connection`,
        );
      }
      if (current > highest) {
        throw new Error(
          `database is at user_version ${current}, which is newer than the highest ` +
            `known migration (${highest}); it was created by a newer version of ` +
            `Cairn and cannot be safely opened by this one`,
        );
      }
    } else {
      runMigrations(driver);
    }

    const statementCache = new Map<string, PreparedStatement>();
    let txDepth = 0;
    let rollbackOnly = false;

    return {
      path,
      driverName: driver.name,
      capabilities,

      q(sql: string): PreparedStatement {
        const cached = statementCache.get(sql);
        if (cached) {
          // Refresh recency: delete + re-set moves the key to the end of
          // Map's iteration order, which is what the eviction below reads.
          statementCache.delete(sql);
          statementCache.set(sql, cached);
          return cached;
        }
        const stmt = driver.prepare(sql);
        // The cursor inside `stmt` is stateful and shared by every caller
        // that gets this cached wrapper back, so `iterate` must not drive
        // that shared cursor: it prepares a fresh statement per call
        // instead, while `get`/`all`/`run` reuse the cached one. This fresh
        // prepare removes statement-level cursor aliasing ONLY (driver
        // contract rule 7) -- it says nothing about connection-level
        // iterator exclusivity (rule 4). Callers must still not touch the
        // connection while an iterate() from this or any other statement is
        // unfinished, or the code stops being portable to bindings (e.g.
        // better-sqlite3) that lock the whole connection for that.
        const wrapper: PreparedStatement = {
          get: (...params) => stmt.get(...params),
          all: (...params) => stmt.all(...params),
          run: (...params) => stmt.run(...params),
          iterate: (...params) => driver.prepare(sql).iterate(...params),
        };
        statementCache.set(sql, wrapper);
        if (statementCache.size > STATEMENT_CACHE_LIMIT) {
          const oldestKey = statementCache.keys().next().value;
          if (oldestKey !== undefined) {
            statementCache.delete(oldestKey);
          }
        }
        return wrapper;
      },

      exec(sql: string): void {
        driver.exec(sql);
      },

      tx<T>(fn: () => T): T {
        // SQLite has no nested transactions, and BUILD_BRIEF §4 requires a
        // single serialized writer: nested tx() calls join the enclosing
        // transaction instead of issuing their own BEGIN/COMMIT. BEGIN is
        // issued before txDepth is incremented so a throwing BEGIN (e.g.
        // "database is locked") never leaves the counter stuck above 0 --
        // a stuck counter would silently disable BEGIN/COMMIT/ROLLBACK for
        // every later tx() on this CairnDb.
        const isOutermost = txDepth === 0;
        if (isOutermost) {
          driver.exec("BEGIN IMMEDIATE");
        }
        txDepth += 1;
        try {
          const result = fn();
          if (isOutermost) {
            if (rollbackOnly) {
              try {
                driver.exec("ROLLBACK");
              } catch {
                // SQLite already rolled back the transaction itself.
              }
              throw new Error(
                "transaction was marked rollback-only by a failed nested tx",
              );
            }
            driver.exec("COMMIT");
          }
          return result;
        } catch (error) {
          if (!isOutermost) {
            // A swallowed nested failure must not let the outer frame
            // commit the work the inner level rolled back on.
            rollbackOnly = true;
          } else {
            try {
              driver.exec("ROLLBACK");
            } catch {
              // SQLite may have already rolled back on its own (ON
              // CONFLICT ROLLBACK, SQLITE_FULL, IOERR): the explicit
              // ROLLBACK then throws "cannot rollback - no transaction is
              // active", which would replace the real error below.
            }
          }
          throw error;
        } finally {
          txDepth -= 1;
          if (isOutermost) {
            rollbackOnly = false;
          }
        }
      },

      close(): void {
        statementCache.clear();
        driver.close();
      },
    };
  } catch (error) {
    driver.close();
    throw error;
  }
}
