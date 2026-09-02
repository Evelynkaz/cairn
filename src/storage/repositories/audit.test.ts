import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db.js";
import { withTempDir, tempDbPath } from "../../testing/tmp.js";
import {
  recordAudit,
  listAudit,
  countAuditByClient,
  registerClient,
  getClient,
  listClients,
  setClientEnabled,
  isClientEnabled,
} from "./audit.js";

test("recordAudit stores and listAudit reads back every field; details round-trips as object or null", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const id = recordAudit(db, {
        action: "remember",
        memoryId: "mem-1",
        scope: "default",
        sourceClient: "claude",
        query: "what did I say about x",
        resultCount: 3,
        details: { flag: true, count: 2 },
      });
      assert.equal(typeof id, "number");

      const idNoDetails = recordAudit(db, {
        action: "forget",
        memoryId: null,
        scope: null,
        sourceClient: null,
        query: null,
        resultCount: null,
        details: null,
      });

      const { items } = listAudit(db);
      const withDetails = items.find((e) => e.id === id);
      const withoutDetails = items.find((e) => e.id === idNoDetails);

      assert.ok(withDetails);
      assert.equal(withDetails.action, "remember");
      assert.equal(withDetails.memoryId, "mem-1");
      assert.equal(withDetails.scope, "default");
      assert.equal(withDetails.sourceClient, "claude");
      assert.equal(withDetails.query, "what did I say about x");
      assert.equal(withDetails.resultCount, 3);
      assert.deepEqual(withDetails.details, { flag: true, count: 2 });
      assert.equal(typeof withDetails.ts, "number");

      assert.ok(withoutDetails);
      assert.equal(withoutDetails.details, null);
      assert.notEqual(withoutDetails.details, "null");
    } finally {
      db.close();
    }
  });
});

test("refused defaults to false and round-trips as a boolean through recordAudit/listAudit", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const defaultedId = recordAudit(db, { action: "recall" });
      const refusedId = recordAudit(db, { action: "recall", refused: true });

      const { items } = listAudit(db);
      const defaulted = items.find((e) => e.id === defaultedId);
      const refused = items.find((e) => e.id === refusedId);

      assert.ok(defaulted);
      assert.equal(defaulted.refused, false);
      assert.ok(refused);
      assert.equal(refused.refused, true);
    } finally {
      db.close();
    }
  });
});

test("listAudit({ refused: true }) returns only refusals; the default returns everything", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      recordAudit(db, { action: "recall" });
      recordAudit(db, { action: "remember", refused: true });
      recordAudit(db, { action: "forget", refused: true });

      const all = listAudit(db);
      assert.equal(all.items.length, 3);

      const refusedOnly = listAudit(db, { refused: true });
      assert.equal(refusedOnly.items.length, 2);
      assert.ok(refusedOnly.items.every((e) => e.refused));

      const notRefused = listAudit(db, { refused: false });
      assert.equal(notRefused.items.length, 1);
    } finally {
      db.close();
    }
  });
});

test("listAudit filters by action, sourceClient, memoryId, and a since/until window", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const insert = db.q(
        `INSERT INTO audit_log (ts, action, memory_id, scope, source_client, query, result_count, details)
         VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL)`,
      );
      const t0 = 1000;
      const t1 = 2000;
      const t2 = 3000;
      insert.run(t0, "remember", "mem-a", "claude");
      insert.run(t1, "recall", "mem-b", "cursor");
      insert.run(t2, "forget", "mem-a", "claude");

      assert.equal(listAudit(db, { action: "recall" }).items.length, 1);
      assert.equal(listAudit(db, { sourceClient: "claude" }).items.length, 2);
      assert.equal(listAudit(db, { memoryId: "mem-a" }).items.length, 2);
      assert.equal(listAudit(db, { since: t1, until: t2 }).items.length, 2);
      assert.equal(listAudit(db, { since: t0, until: t0 }).items.length, 1);
    } finally {
      db.close();
    }
  });
});

test("pagination over 25 same-timestamp events returns each exactly once across pages of 7 (tuple cursor)", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const ts = 1700000000000;
      const insert = db.q(
        `INSERT INTO audit_log (ts, action, memory_id, scope, source_client, query, result_count, details)
         VALUES (?, 'recall', NULL, NULL, NULL, ?, NULL, NULL)`,
      );
      const ids: number[] = [];
      for (let i = 0; i < 25; i++) {
        const result = insert.run(ts, `q${i}`);
        ids.push(result.lastInsertRowid);
      }

      const seen: number[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const { items, nextCursor } = listAudit(db, { limit: 7, cursor });
        for (const item of items) {
          seen.push(item.id);
        }
        if (!nextCursor) {
          break;
        }
        cursor = nextCursor;
      }

      assert.equal(seen.length, 25);
      assert.equal(new Set(seen).size, 25);
      assert.deepEqual([...seen].sort((a, b) => a - b), [...ids].sort((a, b) => a - b));
    } finally {
      db.close();
    }
  });
});

test("listAudit limit defaults to 50 and clamps to 200", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      for (let i = 0; i < 205; i++) {
        recordAudit(db, { action: "recall" });
      }
      const defaultPage = listAudit(db);
      assert.equal(defaultPage.items.length, 50);

      const clamped = listAudit(db, { limit: 10000 });
      assert.equal(clamped.items.length, 200);
    } finally {
      db.close();
    }
  });
});

test("listAudit clamps limit for 0, NaN, 10.7, undefined, and 500 instead of throwing", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      for (let i = 0; i < 60; i++) {
        recordAudit(db, { action: "recall" });
      }
      assert.equal(listAudit(db, { limit: 0 }).items.length, 50);
      assert.equal(listAudit(db, { limit: NaN }).items.length, 50);
      assert.equal(listAudit(db, { limit: 10.7 }).items.length, 10);
      assert.equal(listAudit(db, { limit: undefined }).items.length, 50);
      assert.equal(listAudit(db, { limit: 500 }).items.length, 60);
    } finally {
      db.close();
    }
  });
});

test("listAudit treats an empty-string cursor as no cursor and returns the first page", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      recordAudit(db, { action: "recall" });
      recordAudit(db, { action: "recall" });
      const withoutCursor = listAudit(db);
      const withEmptyCursor = listAudit(db, { cursor: "" });
      assert.deepEqual(
        withEmptyCursor.items.map((e) => e.id),
        withoutCursor.items.map((e) => e.id),
      );
    } finally {
      db.close();
    }
  });
});

test("listAudit throws a descriptive error on a malformed cursor", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      assert.throws(() => listAudit(db, { cursor: "not-a-real-cursor!!" }), /malformed audit cursor/);
    } finally {
      db.close();
    }
  });
});

test("recordAudit never throws for a memory id that does not exist", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      assert.doesNotThrow(() => recordAudit(db, { action: "recall", memoryId: "does-not-exist" }));
    } finally {
      db.close();
    }
  });
});

test("audit rows survive a hard DELETE of the memory they reference (no foreign key)", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const now = Date.now();
      db.q(
        `INSERT INTO memories (id, text, scope, created_at, updated_at, valid_from, content_hash)
         VALUES (?, ?, 'default', ?, ?, ?, ?)`,
      ).run("mem-purge", "some text", now, now, now, "hash-1");

      const auditId = recordAudit(db, { action: "remember", memoryId: "mem-purge" });

      db.q("DELETE FROM memories WHERE id = ?").run("mem-purge");

      const { items } = listAudit(db, { memoryId: "mem-purge" });
      assert.ok(items.some((e) => e.id === auditId));
    } finally {
      db.close();
    }
  });
});

test("registerClient sets first_seen once and advances last_seen on repeat calls", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const first = registerClient(db, "cursor", "Cursor IDE");
      db.q("UPDATE clients SET last_seen = ? WHERE id = ?").run(first.lastSeen - 10000, "cursor");

      const second = registerClient(db, "cursor", "Cursor IDE");
      assert.equal(second.firstSeen, first.firstSeen);
      assert.ok(second.lastSeen > first.lastSeen - 10000);
    } finally {
      db.close();
    }
  });
});

test("a paused client stays paused after reconnecting via registerClient", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      registerClient(db, "cursor");
      const disabled = setClientEnabled(db, "cursor", false);
      assert.equal(disabled.enabled, false);

      const reconnected = registerClient(db, "cursor");
      assert.equal(reconnected.enabled, false);
      assert.equal(getClient(db, "cursor")?.enabled, false);
    } finally {
      db.close();
    }
  });
});

test("isClientEnabled returns true for an unknown client", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      assert.equal(isClientEnabled(db, "never-registered"), true);
    } finally {
      db.close();
    }
  });
});

test("countAuditByClient classifies reads and writes per client and respects since", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      recordAudit(db, { action: "remember", sourceClient: "claude" });
      recordAudit(db, { action: "recall", sourceClient: "claude" });
      recordAudit(db, { action: "recall", sourceClient: "claude" });
      recordAudit(db, { action: "forget", sourceClient: "cursor" });

      const counts = countAuditByClient(db);
      const claude = counts.find((c) => c.sourceClient === "claude");
      const cursor = counts.find((c) => c.sourceClient === "cursor");
      assert.ok(claude);
      assert.equal(claude.reads, 2);
      assert.equal(claude.writes, 1);
      assert.ok(cursor);
      assert.equal(cursor.reads, 0);
      assert.equal(cursor.writes, 1);

      const future = countAuditByClient(db, { since: Date.now() + 60000 });
      assert.equal(future.length, 0);
    } finally {
      db.close();
    }
  });
});

test("countAuditByClient excludes refused rows: a paused client's blocked attempts do not count as writes", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      recordAudit(db, { action: "remember", sourceClient: "paused" });
      recordAudit(db, { action: "remember", sourceClient: "paused" });
      recordAudit(db, { action: "remember", sourceClient: "paused", refused: true });
      recordAudit(db, { action: "remember", sourceClient: "paused", refused: true });
      recordAudit(db, { action: "remember", sourceClient: "paused", refused: true });

      const counts = countAuditByClient(db);
      const paused = counts.find((c) => c.sourceClient === "paused");
      assert.ok(paused);
      assert.equal(paused.writes, 2);
    } finally {
      db.close();
    }
  });
});

test("countAuditByClient clamps its limit and orders by total activity descending", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      for (let i = 0; i < 3; i++) {
        recordAudit(db, { action: "recall", sourceClient: "quiet" });
      }
      for (let i = 0; i < 5; i++) {
        recordAudit(db, { action: "recall", sourceClient: "medium" });
      }
      for (let i = 0; i < 9; i++) {
        recordAudit(db, { action: "recall", sourceClient: "loud" });
      }

      const counts = countAuditByClient(db);
      assert.deepEqual(
        counts.map((c) => c.sourceClient),
        ["loud", "medium", "quiet"],
      );

      const clamped = countAuditByClient(db, { limit: 1 });
      assert.equal(clamped.length, 1);
      assert.equal(clamped[0]?.sourceClient, "loud");
    } finally {
      db.close();
    }
  });
});

test("listClients clamps its limit", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      for (let i = 0; i < 5; i++) {
        registerClient(db, `client-${i}`);
      }
      assert.equal(listClients(db, { limit: 2 }).length, 2);
      assert.equal(listClients(db).length, 5);
    } finally {
      db.close();
    }
  });
});
