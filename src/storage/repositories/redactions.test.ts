import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db.js";
import { withTempDir, tempDbPath } from "../../testing/tmp.js";
import {
  recordRedactions,
  listRedactions,
  countRedactionsByKind,
  deleteRedactionsForMemory,
} from "./redactions.js";

test("recordRedactions stores and listRedactions reads back every field", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      recordRedactions(db, [
        {
          memoryId: "mem-1",
          episodeId: "ep-1",
          scope: "default",
          sourceClient: "claude",
          kind: "aws_access_key",
          preview: "AKIA****MASKED",
          action: "redacted",
        },
      ]);

      const { items } = listRedactions(db);
      assert.equal(items.length, 1);
      const item = items[0];
      assert.ok(item);
      assert.equal(item.memoryId, "mem-1");
      assert.equal(item.episodeId, "ep-1");
      assert.equal(item.scope, "default");
      assert.equal(item.sourceClient, "claude");
      assert.equal(item.kind, "aws_access_key");
      assert.equal(item.preview, "AKIA****MASKED");
      assert.equal(item.action, "redacted");
      assert.equal(typeof item.ts, "number");
      assert.equal(typeof item.id, "number");
    } finally {
      db.close();
    }
  });
});

test("recordRedactions with an empty array is a no-op that touches nothing", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      assert.doesNotThrow(() => recordRedactions(db, []));
      assert.equal(listRedactions(db).items.length, 0);
    } finally {
      db.close();
    }
  });
});

test("action CHECK rejects a value other than 'redacted' or 'blocked'", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      assert.throws(
        () =>
          db
            .q(
              `INSERT INTO redactions (ts, kind, preview, action) VALUES (?, ?, ?, ?)`,
            )
            .run(Date.now(), "api_key", "masked", "leaked"),
        /CHECK constraint failed/,
      );
    } finally {
      db.close();
    }
  });
});

test("pagination over 25 same-timestamp redactions returns each exactly once across pages of 7 (tuple cursor)", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const ts = 1700000000000;
      const insert = db.q(
        `INSERT INTO redactions (ts, kind, preview, action) VALUES (?, 'api_key', ?, 'redacted')`,
      );
      const ids: number[] = [];
      for (let i = 0; i < 25; i++) {
        const result = insert.run(ts, `preview-${i}`);
        ids.push(result.lastInsertRowid);
      }

      const seen: number[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const { items, nextCursor } = listRedactions(db, { limit: 7, cursor });
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

test("listRedactions throws a descriptive error on a malformed cursor", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      assert.throws(() => listRedactions(db, { cursor: "not-a-real-cursor!!" }), /malformed redactions cursor/);
    } finally {
      db.close();
    }
  });
});

// Regression for a hostile-input finding (BUILD_BRIEF §10/§12): a cursor is
// opaque and never meant to be echoed back -- a well-formed-but-huge cursor
// (a plausible `ts:id` pair whose id is not a valid redactions row id) must
// not smuggle unbounded caller-chosen text into the thrown message.
test("listRedactions: a 500,000-character cursor produces a bounded message, not an unbounded echo", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const hugeCursor = Buffer.from(`1700000000000:${"Q".repeat(500_000)}`, "utf8").toString("base64url");
      assert.throws(() => listRedactions(db, { cursor: hugeCursor }), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.length < 200, `expected a bounded message, got length ${err.message.length}`);
        return true;
      });
    } finally {
      db.close();
    }
  });
});

// Pins the dashboard's 400-vs-500 mapping (src/dashboard/api.ts's
// isMalformedCursorError): if this decoder's wording ever drifts from
// "malformed .*cursor", a bad cursor silently becomes a 500 instead of a
// 400. Duplicated literally (not imported) because isMalformedCursorError is
// not exported.
test("listRedactions's malformed-cursor message matches the dashboard's isMalformedCursorError pattern", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      assert.throws(() => listRedactions(db, { cursor: "not-a-real-cursor!!" }), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(/malformed .*cursor/i.test(err.message));
        return true;
      });
    } finally {
      db.close();
    }
  });
});

test("listRedactions treats an empty-string cursor as no cursor and returns the first page", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      recordRedactions(db, [
        { kind: "api_key", preview: "p1", action: "redacted" },
        { kind: "api_key", preview: "p2", action: "blocked" },
      ]);
      const withoutCursor = listRedactions(db);
      const withEmptyCursor = listRedactions(db, { cursor: "" });
      assert.deepEqual(
        withEmptyCursor.items.map((r) => r.id),
        withoutCursor.items.map((r) => r.id),
      );
    } finally {
      db.close();
    }
  });
});

test("listRedactions filters by action, memoryId, and since", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const insert = db.q(
        `INSERT INTO redactions (ts, memory_id, kind, preview, action) VALUES (?, ?, ?, ?, ?)`,
      );
      const t0 = 1000;
      const t1 = 2000;
      const t2 = 3000;
      insert.run(t0, "mem-a", "api_key", "p0", "redacted");
      insert.run(t1, "mem-b", "aws_secret", "p1", "blocked");
      insert.run(t2, "mem-a", "api_key", "p2", "redacted");

      assert.equal(listRedactions(db, { action: "blocked" }).items.length, 1);
      assert.equal(listRedactions(db, { memoryId: "mem-a" }).items.length, 2);
      assert.equal(listRedactions(db, { since: t1 }).items.length, 2);
    } finally {
      db.close();
    }
  });
});

test("countRedactionsByKind groups by kind and action, and is bounded", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      recordRedactions(db, [
        { kind: "api_key", preview: "p1", action: "redacted" },
        { kind: "api_key", preview: "p2", action: "redacted" },
        { kind: "api_key", preview: "p3", action: "blocked" },
        { kind: "aws_secret", preview: "p4", action: "redacted" },
      ]);

      const counts = countRedactionsByKind(db);
      const apiRedacted = counts.find((c) => c.kind === "api_key" && c.action === "redacted");
      const apiBlocked = counts.find((c) => c.kind === "api_key" && c.action === "blocked");
      const awsRedacted = counts.find((c) => c.kind === "aws_secret" && c.action === "redacted");

      assert.ok(apiRedacted);
      assert.equal(apiRedacted.count, 2);
      assert.ok(apiBlocked);
      assert.equal(apiBlocked.count, 1);
      assert.ok(awsRedacted);
      assert.equal(awsRedacted.count, 1);

      const clamped = countRedactionsByKind(db, { limit: 1 });
      assert.equal(clamped.length, 1);
    } finally {
      db.close();
    }
  });
});

test("deleteRedactionsForMemory removes only that memory's rows", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      recordRedactions(db, [
        { memoryId: "mem-a", kind: "api_key", preview: "p1", action: "redacted" },
        { memoryId: "mem-a", kind: "api_key", preview: "p2", action: "redacted" },
        { memoryId: "mem-b", kind: "api_key", preview: "p3", action: "redacted" },
      ]);

      const deleted = deleteRedactionsForMemory(db, "mem-a");
      assert.equal(deleted, 2);

      const remaining = listRedactions(db);
      assert.equal(remaining.items.length, 1);
      assert.equal(remaining.items[0]?.memoryId, "mem-b");
    } finally {
      db.close();
    }
  });
});

test("a redaction row survives a hard DELETE of the memory it names (no foreign key)", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const now = Date.now();
      db.q(
        `INSERT INTO memories (id, text, scope, created_at, updated_at, valid_from, content_hash)
         VALUES (?, ?, 'default', ?, ?, ?, ?)`,
      ).run("mem-purge", "some text", now, now, now, "hash-redactions-1");

      recordRedactions(db, [
        { memoryId: "mem-purge", kind: "api_key", preview: "p1", action: "redacted" },
      ]);

      db.q("DELETE FROM memories WHERE id = ?").run("mem-purge");

      const { items } = listRedactions(db, { memoryId: "mem-purge" });
      assert.equal(items.length, 1);
    } finally {
      db.close();
    }
  });
});
