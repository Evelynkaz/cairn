import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { withTempDir, withTempDirAsync, tempDbPath } from "../testing/tmp.js";
import { openNodeSqlite } from "./driver/node-sqlite.js";
import { migrations, runMigrations } from "./migrations/index.js";
import type { Migration } from "./migrations/index.js";
import { migration001 } from "./migrations/001-init.js";

function userVersion(driver: ReturnType<typeof openNodeSqlite>): number {
  const row = driver.prepare("PRAGMA user_version").get();
  return Number(row?.["user_version"]);
}

test("fresh database ends at user_version 4", () => {
  withTempDir((dir) => {
    const driver = openNodeSqlite({ path: tempDbPath(dir) });
    try {
      const result = runMigrations(driver);
      assert.deepEqual(result, { from: 0, to: 4 });
      assert.equal(userVersion(driver), 4);
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
    assert.deepEqual(again, { from: 4, to: 4 });
    driver.close();

    const reopened = openNodeSqlite({ path });
    try {
      assert.doesNotThrow(() => {
        const result = runMigrations(reopened);
        assert.deepEqual(result, { from: 4, to: 4 });
      });
    } finally {
      reopened.close();
    }
  });
});

test("a database already at version 1 upgrades to 4 WITHOUT re-running migration 001", () => {
  withTempDir((dir) => {
    const path = tempDbPath(dir);
    const driver = openNodeSqlite({ path });
    try {
      // Apply only migration 001 first, via the runner's injectable list --
      // this is the first time the runner has ever been exercised with a
      // database that starts a run already partway up the chain.
      const first = runMigrations(driver, [migration001]);
      assert.deepEqual(first, { from: 0, to: 1 });

      // Seed data that a naive replay of migration 001 (e.g. a
      // CREATE TABLE with no IF NOT EXISTS) would either collide with or
      // wipe out.
      const now = Date.now();
      driver.exec(
        `INSERT INTO memories (id, text, scope, created_at, updated_at, valid_from, content_hash)
         VALUES ('preexisting', 'kept across the upgrade', 'default', ${now}, ${now}, ${now}, 'hash-upgrade')`,
      );

      const second = runMigrations(driver, migrations);
      assert.deepEqual(second, { from: 1, to: 4 });
      assert.equal(userVersion(driver), 4);

      const redactionsTable = driver
        .prepare("select name from sqlite_master where name = 'redactions'")
        .get();
      assert.ok(redactionsTable);

      const preserved = driver
        .prepare("select text from memories where id = 'preexisting'")
        .get();
      assert.equal(preserved?.["text"], "kept across the upgrade");
    } finally {
      driver.close();
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

test("regression: two real processes racing runMigrations against one fresh database both succeed exactly once (a racer must not replay a migration it waited out)", async () => {
  const highest = migrations.reduce((max, m) => Math.max(max, m.version), 0);

  function runChild(path: string): ReturnType<typeof spawn> {
    return spawn(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import { openNodeSqlite } from "${new URL("./driver/node-sqlite.js", import.meta.url).href}";
      import { runMigrations } from "${new URL("./migrations/index.js", import.meta.url).href}";
      const driver = openNodeSqlite({ path: ${JSON.stringify(path)} });
      try {
        // busy_timeout is what lets the loser wait out the winner's
        // BEGIN IMMEDIATE instead of failing outright with SQLITE_BUSY --
        // exactly the condition under which a stale pre-wait user_version
        // snapshot would cause it to replay already-applied DDL.
        driver.exec("PRAGMA busy_timeout=5000");
        const result = runMigrations(driver);
        process.stdout.write("OK:" + JSON.stringify(result) + "\\n");
      } catch (e) {
        process.stdout.write("ERR:" + e.message + "\\n");
      } finally {
        driver.close();
      }
      `,
    ]);
  }

  async function childOutput(child: ReturnType<typeof spawn>): Promise<string> {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    return out.trim();
  }

  const TRIALS = 40;
  for (let i = 0; i < TRIALS; i++) {
    await withTempDirAsync(async (dir) => {
      const path = tempDbPath(dir);

      const a = runChild(path);
      const b = runChild(path);
      const [outA, outB] = await Promise.all([childOutput(a), childOutput(b)]);

      assert.ok(outA.startsWith("OK:"), `first racer failed on trial ${i}: ${outA}`);
      assert.ok(outB.startsWith("OK:"), `second racer failed on trial ${i}: ${outB}`);

      const check = openNodeSqlite({ path });
      try {
        const row = check.prepare("PRAGMA user_version").get();
        assert.equal(Number(row?.["user_version"]), highest, `trial ${i}: unexpected final user_version`);
        const episodesTables = check
          .prepare("select count(*) as n from sqlite_master where type = 'table' and name = 'episodes'")
          .get();
        assert.equal(episodesTables?.["n"], 1, `trial ${i}: episodes table should exist exactly once`);
      } finally {
        check.close();
      }
    });
  }
});

test("the real migration list is exported sorted ascending by version", () => {
  const versions = migrations.map((m) => m.version);
  const sorted = [...versions].sort((a, b) => a - b);
  assert.deepEqual(versions, sorted);
});
