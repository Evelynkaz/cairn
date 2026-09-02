import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempDir, tempDbPath } from "../testing/tmp.js";
import { openNodeSqlite } from "./driver/node-sqlite.js";
import { migrations, runMigrations } from "./migrations/index.js";
import type { Migration } from "./migrations/index.js";

function userVersion(driver: ReturnType<typeof openNodeSqlite>): number {
  const row = driver.prepare("PRAGMA user_version").get();
  return Number(row?.["user_version"]);
}

test("fresh database ends at user_version 1", () => {
  withTempDir((dir) => {
    const driver = openNodeSqlite({ path: tempDbPath(dir) });
    try {
      const result = runMigrations(driver);
      assert.deepEqual(result, { from: 0, to: 1 });
      assert.equal(userVersion(driver), 1);
    } finally {
      driver.close();
    }
  });
});

test("running migrations again is a no-op, including across a fresh connection to the same file", () => {
  withTempDir((dir) => {
    const path = tempDbPath(dir);
    const driver = openNodeSqlite({ path });
    runMigrations(driver);
    const again = runMigrations(driver);
    assert.deepEqual(again, { from: 1, to: 1 });
    driver.close();

    const reopened = openNodeSqlite({ path });
    try {
      assert.doesNotThrow(() => {
        const result = runMigrations(reopened);
        assert.deepEqual(result, { from: 1, to: 1 });
      });
    } finally {
      reopened.close();
    }
  });
});

test("a database created by a newer Cairn version refuses to open", () => {
  withTempDir((dir) => {
    const driver = openNodeSqlite({ path: tempDbPath(dir) });
    try {
      driver.exec("PRAGMA user_version = 99");
      assert.throws(() => runMigrations(driver), /newer version/);
    } finally {
      driver.close();
    }
  });
});

test("a failing migration leaves user_version and schema untouched, and names itself in the error", () => {
  withTempDir((dir) => {
    const driver = openNodeSqlite({ path: tempDbPath(dir) });
    try {
      const originalError = new Error("boom");
      const failing: Migration = {
        version: 1,
        name: "boom-migration",
        up(d) {
          d.exec("CREATE TABLE partial_table(x)");
          throw originalError;
        },
      };

      let thrown: unknown;
      try {
        runMigrations(driver, [failing]);
      } catch (error) {
        thrown = error;
      }

      assert.ok(thrown instanceof Error);
      assert.match(thrown.message, /1/);
      assert.match(thrown.message, /boom-migration/);
      assert.equal(thrown.cause, originalError);

      assert.equal(userVersion(driver), 0);
      const table = driver
        .prepare("select name from sqlite_master where name = 'partial_table'")
        .get();
      assert.equal(table, undefined);
    } finally {
      driver.close();
    }
  });
});

test("the real migration list is exported sorted ascending by version", () => {
  const versions = migrations.map((m) => m.version);
  const sorted = [...versions].sort((a, b) => a - b);
  assert.deepEqual(versions, sorted);
});
