import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db.js";
import { withTempDir, tempDbPath } from "../../testing/tmp.js";
import { createMemory, softDeleteMemory, supersedeMemory } from "./memories.js";
import { memoryStats } from "./stats.js";

test("memoryStats counts live/deleted/superseded correctly and excludes non-live from scopes/topTags/recentActivity", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const { memory: live } = createMemory(db, { text: "alpha", scope: "work", tags: ["a"] });
      const { memory: toDelete } = createMemory(db, { text: "beta", scope: "work", tags: ["b"] });
      const { memory: toSupersede } = createMemory(db, { text: "gamma", scope: "home", tags: ["c"] });

      softDeleteMemory(db, toDelete.id);
      supersedeMemory(db, toSupersede.id, { text: "gamma v2", scope: "home", tags: ["c"] });

      const stats = memoryStats(db);

      // live: `live` and the replacement for gamma.
      assert.equal(stats.liveMemories, 2);
      assert.equal(stats.deletedMemories, 1);
      assert.equal(stats.supersededMemories, 1);
      assert.equal(stats.episodes, 0);
      assert.equal(stats.redactedMemories, 0);

      assert.deepEqual(
        stats.scopes.map((s) => s.scope).sort(),
        ["home", "work"],
      );
      const workScope = stats.scopes.find((s) => s.scope === "work");
      assert.ok(workScope);
      assert.equal(workScope.count, 1);

      const tags = stats.topTags.map((t) => t.tag);
      assert.ok(!tags.includes("b"), "tag from soft-deleted memory must not appear");
      assert.ok(tags.includes("a"));
      assert.ok(tags.includes("c"), "tag from the replacement memory should still appear");

      assert.equal(stats.recentActivity, 2);
      assert.ok(!Number.isNaN(live.createdAt));
    } finally {
      db.close();
    }
  });
});

test("memoryStats orders scopes and topTags by count DESC then name ASC, and truncates to topLimit", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      createMemory(db, { text: "m1", scope: "zeta", tags: ["x"] });
      createMemory(db, { text: "m2", scope: "alpha", tags: ["x"] });
      createMemory(db, { text: "m3", scope: "alpha", tags: ["y"] });
      createMemory(db, { text: "m4", scope: "beta", tags: ["y"] });
      createMemory(db, { text: "m5", scope: "beta", tags: ["y"] });

      const stats = memoryStats(db);
      // alpha=2, beta=2, zeta=1 -> count DESC then scope ASC.
      assert.deepEqual(
        stats.scopes.map((s) => `${s.scope}:${s.count}`),
        ["alpha:2", "beta:2", "zeta:1"],
      );
      // y=3, x=2 -> count DESC then tag ASC.
      assert.deepEqual(
        stats.topTags.map((t) => `${t.tag}:${t.count}`),
        ["y:3", "x:2"],
      );

      const truncated = memoryStats(db, { topLimit: 1 });
      assert.equal(truncated.scopes.length, 1);
      assert.equal(truncated.topTags.length, 1);
      assert.deepEqual(truncated.scopes[0], { scope: "alpha", count: 2 });
      assert.deepEqual(truncated.topTags[0], { tag: "y", count: 3 });
    } finally {
      db.close();
    }
  });
});

test("memoryStats clamps topLimit to [1, 100] with a default of 20", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      for (let i = 0; i < 25; i++) {
        createMemory(db, { text: `m${i}`, scope: `scope-${i}` });
      }

      assert.equal(memoryStats(db).scopes.length, 20);
      assert.equal(memoryStats(db, { topLimit: undefined }).scopes.length, 20);
      assert.equal(memoryStats(db, { topLimit: 0 }).scopes.length, 20);
      assert.equal(memoryStats(db, { topLimit: -1 }).scopes.length, 20);
      assert.equal(memoryStats(db, { topLimit: NaN }).scopes.length, 20);
      assert.equal(memoryStats(db, { topLimit: 1000 }).scopes.length, 25);
    } finally {
      db.close();
    }
  });
});

test("memoryStats clamps topLimit of 1000 down to 100 when enough scopes exist", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      for (let i = 0; i < 150; i++) {
        createMemory(db, { text: `m${i}`, scope: `scope-${i}` });
      }
      assert.equal(memoryStats(db, { topLimit: 1000 }).scopes.length, 100);
    } finally {
      db.close();
    }
  });
});

test("memoryStats recentActivity respects an injected now and an explicit since", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      createMemory(db, { text: "old" });
      const dayMs = 24 * 60 * 60 * 1000;
      const fakeNow = Date.now() + 40 * dayMs;

      // Default 30-day window measured from an injected `now` should exclude
      // a memory created "now" (real time), since fakeNow is 40 days ahead.
      const withInjectedNow = memoryStats(db, { now: () => fakeNow });
      assert.equal(withInjectedNow.recentActivity, 0);

      // An explicit `since` far in the past should include it regardless.
      const withExplicitSince = memoryStats(db, { since: 0 });
      assert.equal(withExplicitSince.recentActivity, 1);
    } finally {
      db.close();
    }
  });
});

test("memoryStats reports null oldestCreatedAt/newestCreatedAt on an empty store", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const stats = memoryStats(db);
      assert.equal(stats.oldestCreatedAt, null);
      assert.equal(stats.newestCreatedAt, null);
      assert.equal(stats.liveMemories, 0);
      assert.equal(stats.scopes.length, 0);
      assert.equal(stats.topTags.length, 0);
    } finally {
      db.close();
    }
  });
});
