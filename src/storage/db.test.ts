import { test } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { withTempDir, withTempDirAsync, tempDbPath } from "../testing/tmp.js";
import { openDb } from "./db.js";
import { openNodeSqlite } from "./driver/node-sqlite.js";
import { migrations } from "./migrations/index.js";

function insertMemory(
  db: ReturnType<typeof openDb>,
  overrides: Partial<{ id: string; text: string; scope: string; contentHash: string }> = {},
): void {
  const now = Date.now();
  db.q(
    `INSERT INTO memories (id, text, scope, created_at, updated_at, valid_from, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.id ?? "mem-1",
    overrides.text ?? "the sky is blue",
    overrides.scope ?? "default",
    now,
    now,
    now,
    overrides.contentHash ?? "hash-1",
  );
}

test("file database sets WAL, busy_timeout, and foreign_keys pragmas", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      assert.equal(db.q("PRAGMA journal_mode").get()?.["journal_mode"], "wal");
      assert.equal(db.q("PRAGMA busy_timeout").get()?.["timeout"], 5000);
      assert.equal(db.q("PRAGMA foreign_keys").get()?.["foreign_keys"], 1);
    } finally {
      db.close();
    }
  });
});

test("file database: capabilities.journalMode is 'wal' and synchronous is NORMAL", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      assert.equal(db.capabilities.journalMode, "wal");
      assert.equal(db.q("PRAGMA synchronous").get()?.["synchronous"], 1);
    } finally {
      db.close();
    }
  });
});

test(":memory: database: journal_mode cannot settle on wal, so synchronous stays at the default FULL", () => {
  const db = openDb({ path: ":memory:" });
  try {
    assert.equal(db.capabilities.journalMode, "memory");
    // This is the assertion that proves the `journalMode === "wal"`
    // conditional around `PRAGMA synchronous=NORMAL` actually fires:
    // removing that conditional (applying NORMAL unconditionally, as
    // before this fix) makes this assertion fail because synchronous
    // would then read 1 (NORMAL) instead of SQLite's default 2 (FULL).
    assert.equal(db.q("PRAGMA synchronous").get()?.["synchronous"], 2);
  } finally {
    db.close();
  }
});

test("capabilities.vectors is true by default and vec_version() works", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      assert.equal(db.capabilities.vectors, true);
      assert.equal(db.capabilities.vectorError, null);
      const row = db.q("select vec_version() as v").get();
      assert.equal(typeof row?.["v"], "string");
    } finally {
      db.close();
    }
  });
});

test("CAIRN_NO_VECTORS=1 disables the extension but the db still opens and FTS still works", () => {
  const previous = process.env["CAIRN_NO_VECTORS"];
  process.env["CAIRN_NO_VECTORS"] = "1";
  try {
    withTempDir((dir) => {
      const db = openDb({ path: tempDbPath(dir) });
      try {
        assert.equal(db.capabilities.vectors, false);
        assert.equal(db.capabilities.vectorError, "disabled by CAIRN_NO_VECTORS");

        insertMemory(db, { text: "hello unique searchable world" });
        const hits = db
          .q("select rowid from memories_fts where memories_fts match ?")
          .all("searchable");
        assert.equal(hits.length, 1);
      } finally {
        db.close();
      }
    });
  } finally {
    if (previous === undefined) {
      delete process.env["CAIRN_NO_VECTORS"];
    } else {
      process.env["CAIRN_NO_VECTORS"] = previous;
    }
  }
});

test("q(sql) caches and returns the identical prepared statement object", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const a = db.q("select 1");
      const b = db.q("select 1");
      assert.equal(a, b);
    } finally {
      db.close();
    }
  });
});

test("tx commits on success and rolls back on throw", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      db.tx(() => {
        insertMemory(db, { id: "mem-commit", contentHash: "hash-commit" });
      });
      assert.equal(db.q("select count(*) as c from memories").get()?.["c"], 1);

      const boom = new Error("boom");
      assert.throws(() => {
        db.tx(() => {
          insertMemory(db, { id: "mem-rollback", contentHash: "hash-rollback" });
          throw boom;
        });
      }, boom);
      assert.equal(db.q("select count(*) as c from memories").get()?.["c"], 1);
    } finally {
      db.close();
    }
  });
});

test("nested tx joins the outer transaction: commits once, rolls back the whole outer on inner throw", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      db.tx(() => {
        insertMemory(db, { id: "outer-1", contentHash: "hash-outer-1" });
        db.tx(() => {
          insertMemory(db, { id: "inner-1", contentHash: "hash-inner-1" });
        });
      });
      assert.equal(db.q("select count(*) as c from memories").get()?.["c"], 2);

      assert.throws(() => {
        db.tx(() => {
          insertMemory(db, { id: "outer-2", contentHash: "hash-outer-2" });
          db.tx(() => {
            insertMemory(db, { id: "inner-2", contentHash: "hash-inner-2" });
            throw new Error("inner boom");
          });
        });
      }, /inner boom/);
      assert.equal(db.q("select count(*) as c from memories").get()?.["c"], 2);
    } finally {
      db.close();
    }
  });
});

test("WAL: a concurrent reader sees pre-commit isolation and does not block the writer's commit", () => {
  withTempDir((dir) => {
    const path = tempDbPath(dir);
    const writer = openDb({ path });
    let reader: ReturnType<typeof openDb> | undefined;
    const rawReader = openNodeSqlite({ path });
    try {
      writer.exec("BEGIN IMMEDIATE");
      insertMemory(writer, { id: "wal-1", contentHash: "hash-wal-1" });

      reader = openDb({ path, readOnly: true });
      assert.equal(reader.q("select count(*) as c from memories").get()?.["c"], 0);

      // A concurrent reader with its own OPEN read transaction must not
      // block this commit: under a rollback journal it would, because
      // committing needs an EXCLUSIVE lock and the reader still holds a
      // SHARED one. A plain pre-commit visibility check alone (the
      // previous version of this test) does not prove WAL is in effect --
      // a rollback-journal reader isolates the same way before COMMIT.
      rawReader.exec("BEGIN");
      rawReader.prepare("select count(*) as c from memories").get();

      writer.exec("COMMIT");
      assert.equal(reader.q("select count(*) as c from memories").get()?.["c"], 1);

      rawReader.exec("COMMIT");
    } finally {
      rawReader.close();
      reader?.close();
      writer.close();
    }
  });
});

test("a second writer fails with 'database is locked' while the first holds BEGIN IMMEDIATE", () => {
  withTempDir((dir) => {
    const path = tempDbPath(dir);
    const writer = openDb({ path });
    const secondDriver = openNodeSqlite({ path });
    try {
      writer.exec("BEGIN IMMEDIATE");
      insertMemory(writer, { id: "lock-1", contentHash: "hash-lock-1" });

      secondDriver.exec("PRAGMA busy_timeout=100");
      assert.throws(() => secondDriver.exec("BEGIN IMMEDIATE"), /database is locked/);

      writer.exec("COMMIT");
    } finally {
      secondDriver.close();
      writer.close();
    }
  });
});

test("regression: two real processes opening the same fresh database concurrently both succeed (busy_timeout must be armed before journal_mode=WAL)", async () => {
  // Schema is pre-migrated with a raw driver so both racers skip
  // runMigrations' own BEGIN IMMEDIATE entirely (user_version already at
  // the highest known version) and land on the exact statement this fix is
  // about: PRAGMA journal_mode=WAL, still un-set on this file. That isolates
  // the pragma-order bug from unrelated contention elsewhere in openDb.
  const highest = migrations.reduce((max, m) => Math.max(max, m.version), 0);

  function runChild(path: string): ReturnType<typeof spawn> {
    return spawn(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import { openDb } from "${new URL("./db.js", import.meta.url).href}";
      try {
        const db = openDb({ path: ${JSON.stringify(path)} });
        db.close();
        process.stdout.write("OK\\n");
      } catch (e) {
        process.stdout.write("ERR:" + e.message + "\\n");
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

  // Real two-process concurrency does not reproduce SQLITE_BUSY on every
  // single run, so this drives enough trials that a reverted pragma order
  // is caught reliably (measured: ~25% of trials fail per run when
  // reverted, 0/40 when fixed) while staying fast enough for CI.
  const TRIALS = 25;
  for (let i = 0; i < TRIALS; i++) {
    await withTempDirAsync(async (dir) => {
      const path = tempDbPath(dir);

      const setup = openNodeSqlite({ path });
      for (const migration of migrations) {
        migration.up(setup);
      }
      setup.exec(`PRAGMA user_version = ${highest}`);
      setup.close();

      const a = runChild(path);
      const b = runChild(path);
      const [outA, outB] = await Promise.all([childOutput(a), childOutput(b)]);

      assert.equal(outA, "OK", `first racer failed on trial ${i}: ${outA}`);
      assert.equal(outB, "OK", `second racer failed on trial ${i}: ${outB}`);
    });
  }
});

test("tx() recovers after a BEGIN IMMEDIATE failure: a later tx() still rolls back on throw", () => {
  withTempDir((dir) => {
    const path = tempDbPath(dir);
    const db = openDb({ path });
    db.exec("PRAGMA busy_timeout=100");
    const blocker = openNodeSqlite({ path });
    blocker.exec("PRAGMA busy_timeout=100");
    try {
      blocker.exec("BEGIN IMMEDIATE");

      // If BEGIN's throw here leaves txDepth stuck above 0 (finding 1),
      // every later tx() on `db` believes it is nested, issues no
      // BEGIN/COMMIT/ROLLBACK, and runs in autocommit forever.
      assert.throws(() => {
        db.tx(() => {
          insertMemory(db, { id: "should-not-run", contentHash: "hash-should-not-run" });
        });
      }, /database is locked/);

      blocker.exec("COMMIT");

      const boom = new Error("boom");
      assert.throws(() => {
        db.tx(() => {
          insertMemory(db, { id: "mem-after-lock", contentHash: "hash-after-lock" });
          throw boom;
        });
      }, boom);

      assert.equal(db.q("select count(*) as c from memories").get()?.["c"], 0);
    } finally {
      blocker.close();
      db.close();
    }
  });
});

test("node:sqlite-specific: q(sql).iterate() allocates a fresh cursor, so get/all on the same cached statement mid-iteration does not corrupt or hang", () => {
  // This pins the statement-cache fix (fresh `prepare` per `iterate` call
  // removes statement-level cursor aliasing), but it deliberately violates
  // driver contract rule 4 (connection-level iterator exclusivity) by
  // running `db.q(SQL).all("b")` inside a live `db.q(SQL).iterate("a")`
  // loop. node:sqlite tolerates that; better-sqlite3 locks the whole
  // connection while an iterator is unfinished and throws "This database
  // connection is busy executing a query" for any other operation on it,
  // including this one. Revisit or delete this test if the driver is ever
  // swapped away from node:sqlite.
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      db.tx(() => {
        insertMemory(db, { id: "a0", scope: "a", text: "alpha zero", contentHash: "hash-a0" });
        insertMemory(db, { id: "a1", scope: "a", text: "alpha one", contentHash: "hash-a1" });
        insertMemory(db, { id: "b0", scope: "b", text: "beta zero", contentHash: "hash-b0" });
      });

      const SQL = "select id from memories where scope = ? order by id";
      const seen: string[] = [];
      const ITERATION_CAP = 100;
      let guard = 0;
      for (const row of db.q(SQL).iterate("a")) {
        if (guard++ > ITERATION_CAP) {
          throw new Error("iteration cap exceeded; likely a shared, corrupted cursor");
        }
        seen.push(String(row["id"]));
        db.q(SQL).all("b");
      }

      assert.deepEqual(seen, ["a0", "a1"]);
    } finally {
      db.close();
    }
  });
});

test("q(sql) caches and returns the identical prepared statement object even after iterate()", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const a = db.q("select 1");
      [...a.iterate()];
      const b = db.q("select 1");
      assert.equal(a, b);
    } finally {
      db.close();
    }
  });
});

test("a nested tx failure swallowed by the outer callback still rolls back and commits nothing", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      assert.throws(() => {
        db.tx(() => {
          insertMemory(db, { id: "outer", contentHash: "hash-outer" });
          try {
            db.tx(() => {
              insertMemory(db, { id: "inner", contentHash: "hash-inner" });
              throw new Error("inner boom");
            });
          } catch {
            // swallowed: the outer callback does not rethrow
          }
          insertMemory(db, { id: "after", contentHash: "hash-after" });
        });
      }, /rollback-only/);

      assert.equal(db.q("select count(*) as c from memories").get()?.["c"], 0);
    } finally {
      db.close();
    }
  });
});

test("an error from SQLite's own auto-rollback surfaces its original message, not 'cannot rollback'", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      insertMemory(db, { id: "existing", contentHash: "dup-hash" });

      assert.throws(() => {
        db.tx(() => {
          db.q(
            `INSERT OR ROLLBACK INTO memories (id, text, scope, created_at, updated_at, valid_from, content_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run("dup", "dup text", "default", Date.now(), Date.now(), Date.now(), "dup-hash");
        });
      }, /UNIQUE constraint failed/);
    } finally {
      db.close();
    }
  });
});

test("openDb on a version-99 database throws and closes the driver so the file can be deleted immediately", () => {
  withTempDir((dir) => {
    const path = tempDbPath(dir);
    const setup = openNodeSqlite({ path });
    setup.exec("PRAGMA user_version = 99");
    setup.close();

    assert.throws(() => openDb({ path }), /newer version of Cairn/);
    // On Windows a leaked handle from the failed open would make this
    // throw EBUSY: resource busy or locked.
    assert.doesNotThrow(() => unlinkSync(path));
  });
});

test("openDb({ readOnly: true }) on a version-99 database throws", () => {
  withTempDir((dir) => {
    const path = tempDbPath(dir);
    const setup = openNodeSqlite({ path });
    setup.exec("PRAGMA user_version = 99");
    setup.close();

    assert.throws(() => openDb({ path, readOnly: true }), /newer version of Cairn/);
  });
});

test("openDb({ readOnly: true }) succeeds against a database that is not already in WAL mode", () => {
  withTempDir((dir) => {
    const path = tempDbPath(dir);
    const writer = openDb({ path });
    writer.exec("PRAGMA journal_mode=DELETE");
    writer.close();

    const reader = openDb({ path, readOnly: true });
    try {
      assert.doesNotThrow(() => reader.q("select count(*) as c from memories").get());
    } finally {
      reader.close();
    }
  });
});

test("recursive_triggers pins FTS sync for REPLACE, but REPLACE is NOT the sanctioned upsert", () => {
  // This pins the recursive_triggers=ON fix: without it, a REPLACE-conflict
  // delete does not fire the memories_ad trigger and memories_fts keeps
  // stale terms. But `INSERT OR REPLACE` is destructive on axes this
  // pragma does not address -- it changes the row's rowid/seq (orphaning
  // vector rows keyed by it), cascades away memory_tags rows, and nulls a
  // predecessor's superseded_by while leaving valid_until set. The
  // sanctioned upsert path is `INSERT ... ON CONFLICT(id) DO UPDATE SET
  // ...`, not REPLACE; that path is tested in schema.test.ts.
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const now = Date.now();
      db.q(
        `INSERT INTO memories (id, text, scope, created_at, updated_at, valid_from, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("mem-1", "alpha searchable term", "default", now, now, now, "hash-1");

      db.q(
        `INSERT OR REPLACE INTO memories (id, text, scope, created_at, updated_at, valid_from, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("mem-1", "beta replaced term", "default", now, now, now, "hash-2");

      const stale = db.q("select rowid from memories_fts where memories_fts match ?").all("alpha");
      const fresh = db.q("select rowid from memories_fts where memories_fts match ?").all("beta");
      assert.equal(stale.length, 0);
      assert.equal(fresh.length, 1);
    } finally {
      db.close();
    }
  });
});

test("the statement cache is bounded at 200 entries", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const first = db.q("select 9999 as x");
      for (let i = 0; i < 250; i++) {
        db.q(`select ${i} as x`);
      }

      const firstAgain = db.q("select 9999 as x");
      assert.notEqual(first, firstAgain);

      const recent = db.q("select 249 as x");
      const recentAgain = db.q("select 249 as x");
      assert.equal(recent, recentAgain);
    } finally {
      db.close();
    }
  });
});

test("close() is idempotent", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    db.close();
    assert.doesNotThrow(() => db.close());
  });
});
