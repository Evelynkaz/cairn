import type { SqliteDriver } from "../driver/index.js";
import { migration001 } from "./001-init.js";
import { migration002 } from "./002-redactions.js";

export interface Migration {
  version: number;
  name: string;
  up(driver: SqliteDriver): void;
}

// Sorted ascending by version.
export const migrations: Migration[] = [migration001, migration002];

function userVersion(driver: SqliteDriver): number {
  const row = driver.prepare("PRAGMA user_version").get();
  const value = row?.["user_version"];
  return typeof value === "number" ? value : Number(value);
}

function setUserVersion(driver: SqliteDriver, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`refusing to set PRAGMA user_version to invalid value: ${version}`);
  }
  // PRAGMA user_version cannot be parameterized; the value is validated
  // above before interpolation.
  driver.exec(`PRAGMA user_version = ${version}`);
}

export function runMigrations(
  driver: SqliteDriver,
  list: Migration[] = migrations,
): { from: number; to: number } {
  const sorted = [...list].sort((a, b) => a.version - b.version);
  const highest = sorted.reduce((max, m) => Math.max(max, m.version), 0);
  const from = userVersion(driver);

  if (from > highest) {
    throw new Error(
      `database is at user_version ${from}, which is newer than the highest ` +
        `known migration (${highest}); it was created by a newer version of ` +
        `Cairn and cannot be safely opened by this one`,
    );
  }

  let current = from;
  for (const migration of sorted) {
    if (migration.version <= current) {
      continue;
    }
    driver.exec("BEGIN IMMEDIATE");
    try {
      // A racing connection may have applied this migration (via its own
      // BEGIN IMMEDIATE) while this one waited out the lock on busy_timeout
      // -- `current`/`from` above were read before that wait, so they can
      // no longer be trusted. Re-read now that the lock is actually held
      // and skip cleanly if the winner already got here first, instead of
      // replaying DDL onto a schema that already has it.
      const actual = userVersion(driver);
      if (migration.version <= actual) {
        driver.exec("COMMIT");
        current = actual;
        continue;
      }
      migration.up(driver);
      setUserVersion(driver, migration.version);
      driver.exec("COMMIT");
    } catch (error) {
      try {
        driver.exec("ROLLBACK");
      } catch {
        // SQLite may have already rolled back on its own (SQLITE_FULL,
        // IOERR, or a migration using INSERT OR ROLLBACK): the explicit
        // ROLLBACK then throws "cannot rollback - no transaction is
        // active", which would replace the real error below.
      }
      throw new Error(
        `migration ${migration.version} (${migration.name}) failed`,
        { cause: error },
      );
    }
    current = migration.version;
  }

  return { from, to: current };
}
