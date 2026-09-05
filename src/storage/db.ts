import { chmodSync } from "node:fs";
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

function isLockError(error: unknown): boolean {
  return error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message);
}

// Best-effort: `path` (or a `-wal`/`-shm` sidecar) may not exist yet -- the
// sidecars only appear once WAL mode actually takes -- or the filesystem may
// refuse chmod entirely (read-only mount, some network filesystems).
// openDb must still succeed either way; the directory (0700, see
// config/paths.ts ensureHome) is the fallback boundary if this can't apply.
function tightenFileMode(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // See comment above: absence or an unsupported filesystem is fine.
  }
}

// Synchronous blocking sleep: openDb is called synchronously all over this
// codebase (CLI commands, every test in this file, driver open itself), so
// the retry below cannot become async without breaking every one of those
// callers. Atomics.wait on a private SharedArrayBuffer blocks this thread
// for `ms` without any new dependency.
function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

// A handful of bounded attempts with a short backoff. This exists here, at
// the layer that actually contends, rather than in any one caller: every
// caller of openDb (the daemon's startup, `cairn status`, `cairn
// embeddings`, ...) races every other one that can also open a fresh
// database, and `PRAGMA journal_mode=WAL` below takes its own EXCLUSIVE
// lock that busy_timeout does not reliably cover -- see the comment on that
// pragma. Retrying only on a lock/busy error keeps a genuine failure (a
// corrupt file, a failed migration) surfacing immediately and unchanged.
const OPEN_RETRY_ATTEMPTS = 5;
const OPEN_RETRY_BASE_DELAY_MS = 25;

export function openDb(options: OpenDbOptions = {}): CairnDb {
  const path = options.path ?? dbPath();
  if (path !== ":memory:") {
    ensureHome(dirname(path));
  }

  const driverFactory = options.driver ?? defaultDriver;
  const readOnly = options.readOnly ?? false;

  for (let attempt = 0; attempt < OPEN_RETRY_ATTEMPTS; attempt++) {
    try {
      return openOnce(driverFactory, path, readOnly);
    } catch (error) {
      if (!isLockError(error) || attempt === OPEN_RETRY_ATTEMPTS - 1) {
        throw error;
      }
      sleepSync(OPEN_RETRY_BASE_DELAY_MS * (attempt + 1));
    }
  }
  // Unreachable: the loop above always either returns or throws.
  throw new Error("openDb: exhausted attempts without a result");
}

function openOnce(driverFactory: DriverFactory, path: string, readOnly: boolean): CairnDb {
  // The driver's own create call uses the process umask, which on a looser
  // default (e.g. 022) leaves a fresh database file world- or
  // group-readable -- the memory store, secrets and all, would then be
  // protected only by the 0700 home directory (config/paths.ts
  // ensureHome), not by the file itself. Restricting the umask for the
  // duration of this call means the file is born at 0600 rather than
  // created loose and tightened after the fact; the chmodSync below is a
  // backstop for a file that already existed (a pre-existing CAIRN_HOME, a
  // restored backup) rather than the primary defence.
  const previousUmask = process.umask(0o077);
  let driver: SqliteDriver;
  try {
    driver = driverFactory({ path, allowExtension: true, readOnly });
  } finally {
    process.umask(previousUmask);
  }
  if (path !== ":memory:") {
    tightenFileMode(path);
  }

  try {
    // busy_timeout must be set FIRST, before any statement that can
    // contend for a lock -- and `PRAGMA journal_mode=WAL` below is exactly
    // such a statement: switching journal modes takes a brief EXCLUSIVE
    // lock. Until busy_timeout is armed, this connection has a zero
    // timeout, so two daemons racing to open the same fresh database (§4:
    // Claude Desktop and Claude Code launching together) can both hit
    // SQLITE_BUSY on the journal-mode switch and fail to start -- instead
    // of one of them waiting the other out, which is the whole point of
    // this setting. Order here is load-bearing; do not move this below
    // journal_mode again.
    driver.exec("PRAGMA busy_timeout=5000");

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
    // The `-wal`/`-shm` sidecars are created by the pragma above (when it
    // actually settles on `wal`), not by the driver's initial open, so they
    // can only be tightened here -- and like the main file, they inherit the
    // process umask unless it was restricted at the moment SQLite created
    // them, which the block above did not do.
    if (path !== ":memory:") {
      tightenFileMode(`${path}-wal`);
      tightenFileMode(`${path}-shm`);
    }
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
      // runMigrations issues its own BEGIN IMMEDIATE per migration, which is
      // exactly the kind of contending statement busy_timeout exists to
      // protect. Since it is set above before this call, a racing daemon's
      // migration run waits out a concurrent one instead of dying with
      // "database is locked".
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
