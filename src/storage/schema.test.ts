import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempDir, tempDbPath } from "../testing/tmp.js";
import { openDb } from "./db.js";

function insertMemory(
  db: ReturnType<typeof openDb>,
  fields: {
    id: string;
    text?: string;
    scope?: string;
    contentHash?: string;
    validUntil?: number | null;
    deletedAt?: number | null;
    importance?: number;
    episodeId?: string | null;
  },
): void {
  const now = Date.now();
  db.q(
    `INSERT INTO memories
       (id, text, scope, created_at, updated_at, valid_from, valid_until, deleted_at, content_hash, importance, episode_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.id,
    fields.text ?? "some text",
    fields.scope ?? "default",
    now,
    now,
    now,
    fields.validUntil ?? null,
    fields.deletedAt ?? null,
    fields.contentHash ?? "hash-x",
    fields.importance ?? 0.5,
    fields.episodeId ?? null,
  );
}

function insertEpisode(
  db: ReturnType<typeof openDb>,
  fields: { id: string; content?: string },
): void {
  db.q(
    `INSERT INTO episodes (id, content, created_at) VALUES (?, ?, ?)`,
  ).run(fields.id, fields.content ?? "some episode content", Date.now());
}

test("partial unique index rejects duplicate live (scope, content_hash) but allows supersede, soft-delete, and cross-scope", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      insertMemory(db, { id: "m1", contentHash: "dup" });

      assert.throws(
        () => insertMemory(db, { id: "m2", contentHash: "dup" }),
        /UNIQUE constraint failed/,
      );

      // Different scope is fine.
      assert.doesNotThrow(() =>
        insertMemory(db, { id: "m3", contentHash: "dup", scope: "other" }),
      );

      // Superseding the first (valid_until set) frees the hash up again.
      db.q("UPDATE memories SET valid_until = ? WHERE id = ?").run(Date.now(), "m1");
      assert.doesNotThrow(() => insertMemory(db, { id: "m4", contentHash: "dup" }));

      // Soft-deleting the second live row frees the hash up again.
      db.q("UPDATE memories SET deleted_at = ? WHERE id = ?").run(Date.now(), "m4");
      assert.doesNotThrow(() => insertMemory(db, { id: "m5", contentHash: "dup" }));
    } finally {
      db.close();
    }
  });
});

test("FTS triggers keep the index in sync with insert, update of text, and delete", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      insertMemory(db, { id: "f1", text: "alpha term", contentHash: "h1" });
      assert.equal(
        db.q("select rowid from memories_fts where memories_fts match ?").all("alpha").length,
        1,
      );

      db.q("UPDATE memories SET text = ? WHERE id = ?").run("beta term", "f1");
      assert.equal(
        db.q("select rowid from memories_fts where memories_fts match ?").all("alpha").length,
        0,
      );
      assert.equal(
        db.q("select rowid from memories_fts where memories_fts match ?").all("beta").length,
        1,
      );

      db.q("DELETE FROM memories WHERE id = ?").run("f1");
      assert.equal(
        db.q("select rowid from memories_fts where memories_fts match ?").all("beta").length,
        0,
      );

      assert.doesNotThrow(() =>
        db.exec("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')"),
      );
    } finally {
      db.close();
    }
  });
});

test("updating a non-text column does not disturb the FTS index", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      insertMemory(db, { id: "g1", text: "gamma term", contentHash: "h2" });

      db.q("UPDATE memories SET importance = ? WHERE id = ?").run(0.1, "g1");
      db.q("UPDATE memories SET importance = ? WHERE id = ?").run(0.9, "g1");
      db.q("UPDATE memories SET importance = ? WHERE id = ?").run(0.4, "g1");

      const hits = db
        .q("select rowid from memories_fts where memories_fts match ?")
        .all("gamma");
      assert.equal(hits.length, 1);
    } finally {
      db.close();
    }
  });
});

test("CHECK constraints reject out-of-range importance and non-boolean redacted", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      assert.throws(
        () => insertMemory(db, { id: "c1", contentHash: "hc1", importance: 1.5 }),
        /CHECK constraint failed/,
      );
      assert.throws(
        () => insertMemory(db, { id: "c2", contentHash: "hc2", importance: -0.1 }),
        /CHECK constraint failed/,
      );

      const now = Date.now();
      assert.throws(
        () =>
          db
            .q(
              `INSERT INTO memories
                 (id, text, scope, created_at, updated_at, valid_from, content_hash, redacted)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run("c3", "text", "default", now, now, now, "hc3", 2),
        /CHECK constraint failed/,
      );
    } finally {
      db.close();
    }
  });
});

test("memory_tags cascades on memory delete, and foreign_keys is enforced", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      insertMemory(db, { id: "t1", contentHash: "ht1" });
      db.q("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)").run("t1", "work");
      assert.equal(
        db.q("select count(*) as c from memory_tags where memory_id = ?").get("t1")?.["c"],
        1,
      );

      db.q("DELETE FROM memories WHERE id = ?").run("t1");
      assert.equal(
        db.q("select count(*) as c from memory_tags where memory_id = ?").get("t1")?.["c"],
        0,
      );

      assert.throws(
        () =>
          db.q("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)").run("nonexistent", "x"),
        /FOREIGN KEY constraint failed/,
      );
    } finally {
      db.close();
    }
  });
});

test("memories_live filters soft-deleted and superseded rows out of FTS search; raw memories_fts does not", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      insertMemory(db, { id: "v1", text: "vista alpha", contentHash: "hv1" });
      insertMemory(db, { id: "v2", text: "vista beta", contentHash: "hv2" });
      insertMemory(db, { id: "v3", text: "vista gamma", contentHash: "hv3" });

      db.q("UPDATE memories SET deleted_at = ? WHERE id = ?").run(Date.now(), "v1");
      db.q("UPDATE memories SET valid_until = ? WHERE id = ?").run(Date.now(), "v2");

      const rawCount = db
        .q("select count(*) as c from memories_fts where memories_fts match ?")
        .get("vista")?.["c"];
      assert.equal(rawCount, 3);

      const liveCount = db
        .q(
          `select count(*) as c
             from memories_fts f
             join memories_live m on m.seq = f.rowid
            where memories_fts match ?`,
        )
        .get("vista")?.["c"];
      assert.equal(liveCount, 1);
    } finally {
      db.close();
    }
  });
});

test("the FTS tokenizer strips diacritics, so 'cafe' matches 'café résumé'", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      insertMemory(db, { id: "d1", text: "café résumé", contentHash: "hd1" });

      const hits = db.q("select rowid from memories_fts where memories_fts match ?").all("cafe");
      assert.equal(hits.length, 1);
    } finally {
      db.close();
    }
  });
});

test("the cross-scope and scope-filtered listing orderings are served by an index, not a temp b-tree sort", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      for (let i = 0; i < 5; i += 1) {
        insertMemory(db, { id: `e${i}`, contentHash: `he${i}` });
      }

      const crossScopePlan = db
        .q("EXPLAIN QUERY PLAN SELECT id FROM memories ORDER BY created_at DESC, id DESC LIMIT 20")
        .all();
      const crossScopeDetail = crossScopePlan.map((r) => r["detail"]).join(" | ");
      assert.doesNotMatch(String(crossScopeDetail), /USE TEMP B-TREE/);

      const scopedPlan = db
        .q(
          "EXPLAIN QUERY PLAN SELECT id FROM memories WHERE scope = ? ORDER BY created_at DESC, id DESC LIMIT 20",
        )
        .all("default");
      const scopedDetail = scopedPlan.map((r) => r["detail"]).join(" | ");
      assert.doesNotMatch(String(scopedDetail), /USE TEMP B-TREE/);
    } finally {
      db.close();
    }
  });
});

test("keyset pagination over (created_at, id) returns every row exactly once when created_at values collide", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const createdAt = 1_700_000_000_000;
      for (let i = 0; i < 10; i += 1) {
        const id = `k${String(i).padStart(2, "0")}`;
        db.q(
          `INSERT INTO memories
             (id, text, scope, created_at, updated_at, valid_from, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, "some text", "default", createdAt, createdAt, createdAt, `hk${i}`);
      }

      const seen: string[] = [];
      let cursorCreatedAt = createdAt + 1;
      let cursorId = "z";
      for (;;) {
        const page = db
          .q(
            `SELECT id, created_at FROM memories
               WHERE (created_at, id) < (?, ?)
               ORDER BY created_at DESC, id DESC
               LIMIT 3`,
          )
          .all(cursorCreatedAt, cursorId);
        if (page.length === 0) {
          break;
        }
        for (const row of page) {
          seen.push(String(row["id"]));
        }
        const last = page[page.length - 1]!;
        cursorCreatedAt = Number(last["created_at"]);
        cursorId = String(last["id"]);
      }

      assert.equal(seen.length, 10);
      assert.equal(new Set(seen).size, 10);
    } finally {
      db.close();
    }
  });
});

test("the audit_log action-filtered and plain listing orderings are served by an index, not a temp b-tree sort", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      for (let i = 0; i < 5; i += 1) {
        db.q(`INSERT INTO audit_log (ts, action) VALUES (?, ?)`).run(Date.now(), "recall");
      }

      const actionPlan = db
        .q(
          "EXPLAIN QUERY PLAN SELECT id FROM audit_log WHERE action = ? ORDER BY ts DESC, id DESC LIMIT 20",
        )
        .all("recall");
      const actionDetail = actionPlan.map((r) => r["detail"]).join(" | ");
      assert.doesNotMatch(String(actionDetail), /USE TEMP B-TREE/);

      const plainPlan = db
        .q("EXPLAIN QUERY PLAN SELECT id FROM audit_log ORDER BY ts DESC, id DESC LIMIT 20")
        .all();
      const plainDetail = plainPlan.map((r) => r["detail"]).join(" | ");
      assert.doesNotMatch(String(plainDetail), /USE TEMP B-TREE/);
    } finally {
      db.close();
    }
  });
});

test("audit_log rows survive a hard delete of the memory they reference", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      insertMemory(db, { id: "a1", contentHash: "ha1" });
      db.q(
        `INSERT INTO audit_log (ts, action, memory_id) VALUES (?, ?, ?)`,
      ).run(Date.now(), "recall", "a1");

      db.q("DELETE FROM memories WHERE id = ?").run("a1");

      const row = db.q("select memory_id from audit_log where memory_id = ?").get("a1");
      assert.equal(row?.["memory_id"], "a1");
    } finally {
      db.close();
    }
  });
});

test("a memory linked to an episode survives the episode's deletion, with episode_id set NULL", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      insertEpisode(db, { id: "ep1" });
      insertMemory(db, { id: "em1", contentHash: "hem1", episodeId: "ep1" });

      db.q("DELETE FROM episodes WHERE id = ?").run("ep1");

      const row = db.q("select episode_id from memories where id = ?").get("em1");
      assert.equal(row?.["episode_id"], null);
    } finally {
      db.close();
    }
  });
});

test("episodes.seq is not reused after a hard delete", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      insertEpisode(db, { id: "es1" });
      const before = db.q("select seq from episodes where id = ?").get("es1");

      db.q("DELETE FROM episodes WHERE id = ?").run("es1");
      insertEpisode(db, { id: "es2" });
      const after = db.q("select seq from episodes where id = ?").get("es2");

      assert.ok(Number(after?.["seq"]) > Number(before?.["seq"]));
    } finally {
      db.close();
    }
  });
});

// Regression test for the privacy hazard described on memories.seq in
// migrations/001-init.ts: with a plain TEXT primary key, SQLite reuses the
// implicit rowid of a hard-deleted row for the next insert, which would let
// a future vec0 table silently inherit the orphaned vector row of a
// memory the user believed was purged, and recall would then return a
// semantic hit for deleted content. AUTOINCREMENT on memories.seq prevents
// this. Removing AUTOINCREMENT from the migration makes this test fail.
test("memories.seq is never reused after a hard delete, even when a deleted row's slot could be recycled", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      insertMemory(db, { id: "rs1", contentHash: "hrs1" });
      insertMemory(db, { id: "rs2", contentHash: "hrs2" });
      const seqBefore = db
        .q("select max(seq) as m from memories")
        .get()?.["m"];

      db.q("DELETE FROM memories WHERE id = ?").run("rs2");
      insertMemory(db, { id: "rs3", contentHash: "hrs3" });
      const seqAfter = db.q("select seq from memories where id = ?").get("rs3");

      assert.ok(Number(seqAfter?.["seq"]) > Number(seqBefore));
    } finally {
      db.close();
    }
  });
});

test("sqlite_master reflects the exact expected schema shape (drift guard for migration 001)", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const rows = db
        .q("select type, name from sqlite_master order by type, name")
        .all();
      const actual = rows.map((r) => `${r["type"]} ${r["name"]}`);

      const expected = [
        "index idx_audit_action_ts",
        "index idx_audit_client_ts",
        "index idx_audit_memory",
        "index idx_audit_ts",
        "index idx_episodes_created",
        "index idx_episodes_scope_created",
        "index idx_memories_created",
        "index idx_memories_episode",
        "index idx_memories_live",
        "index idx_memories_live_hash",
        "index idx_memories_scope_created",
        "index idx_memories_superseded_by",
        "index idx_memory_tags_tag",
        "index idx_redactions_memory",
        "index idx_redactions_ts",
        "index sqlite_autoindex_clients_1",
        "index sqlite_autoindex_episodes_1",
        "index sqlite_autoindex_memories_1",
        "index sqlite_autoindex_memory_tags_1",
        "index sqlite_autoindex_settings_1",
        "index sqlite_autoindex_vector_spaces_1",
        "index sqlite_autoindex_vector_spaces_2",
        "table audit_log",
        "table clients",
        "table episodes",
        "table memories",
        "table memories_fts",
        "table memories_fts_config",
        "table memories_fts_data",
        "table memories_fts_docsize",
        "table memories_fts_idx",
        "table memory_tags",
        "table redactions",
        "table settings",
        "table sqlite_sequence",
        "table vector_spaces",
        "trigger memories_ad",
        "trigger memories_ai",
        "trigger memories_au",
        "view memories_live",
      ];

      assert.deepEqual(actual, expected);
    } finally {
      db.close();
    }
  });
});
