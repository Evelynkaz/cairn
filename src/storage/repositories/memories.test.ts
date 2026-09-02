import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { withTempDir, makeTempDir, tempDbPath } from "../../testing/tmp.js";
import { openDb } from "../db.js";
import type { CairnDb } from "../db.js";
import { timestampFromUuidv7, uuidv7 } from "../../util/id.js";
import { contentHash } from "../../util/text.js";
import {
  createMemory,
  getMemory,
  listMemories,
  memoriesAsOf,
  restoreMemory,
  softDeleteMemory,
  supersedeMemory,
  touchMemory,
  updateMemory,
} from "./memories.js";
import { appendEpisode } from "./episodes.js";

function withDb<T>(fn: (db: CairnDb) => T): T {
  return withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  });
}

// Bypasses createMemory to insert a row with a caller-chosen created_at,
// independent of the id's embedded timestamp -- used only to set up
// same-timestamp fixtures for the keyset pagination test below.
function rawInsertMemory(
  db: CairnDb,
  overrides: Partial<{ id: string; text: string; scope: string; createdAt: number; contentHash: string }> = {},
): string {
  const id = overrides.id ?? uuidv7();
  const createdAt = overrides.createdAt ?? timestampFromUuidv7(id);
  const text = overrides.text ?? id;
  db.q(
    `INSERT INTO memories (id, text, scope, importance, created_at, updated_at, valid_from, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, text, overrides.scope ?? "default", 0.5, createdAt, createdAt, createdAt, overrides.contentHash ?? contentHash(text));
  return id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("createMemory returns tags and created_at derived from the id", () => {
  withDb((db) => {
    const { memory, deduped } = createMemory(db, { text: "the sky is blue", tags: ["b", "a"] });
    assert.equal(deduped, false);
    assert.deepEqual(memory.tags, ["a", "b"]);
    assert.equal(memory.createdAt, timestampFromUuidv7(memory.id));
  });
});

test("dedupe: same text in the same scope returns the same id, unions tags, raises importance to the max", () => {
  withDb((db) => {
    const first = createMemory(db, { text: "water boils at 100C", tags: ["x"], importance: 0.3 });
    assert.equal(first.deduped, false);

    const second = createMemory(db, { text: "water boils at 100C", tags: ["y"], importance: 0.8 });
    assert.equal(second.deduped, true);
    assert.equal(second.memory.id, first.memory.id);
    assert.deepEqual(second.memory.tags, ["x", "y"]);
    assert.equal(second.memory.importance, 0.8);

    const count = db.q("select count(*) as c from memories").get()?.["c"];
    assert.equal(count, 1);
  });
});

test("dedupe: no importance supplied preserves a low importance instead of raising it to the 0.5 default", () => {
  withDb((db) => {
    const first = createMemory(db, { text: "low importance fact", importance: 0.1 });
    const second = createMemory(db, { text: "low importance fact" });
    assert.equal(second.deduped, true);
    assert.equal(second.memory.importance, 0.1);
  });
});

test("dedupe: attaches an episodeId to a row that had none", () => {
  withDb((db) => {
    const episode = appendEpisode(db, { content: "source text" });
    const first = createMemory(db, { text: "no provenance yet" });
    assert.equal(first.memory.episodeId, null);

    const second = createMemory(db, { text: "no provenance yet", episodeId: episode.id });
    assert.equal(second.deduped, true);
    assert.equal(second.memory.episodeId, episode.id);
  });
});

test("dedupe: the same text in a different scope creates a new row", () => {
  withDb((db) => {
    const first = createMemory(db, { text: "same text", scope: "a" });
    const second = createMemory(db, { text: "same text", scope: "b" });
    assert.equal(second.deduped, false);
    assert.notEqual(second.memory.id, first.memory.id);
  });
});

test("dedupe: the same text after the first was soft-deleted creates a new row", () => {
  withDb((db) => {
    const first = createMemory(db, { text: "soft delete then repeat" });
    softDeleteMemory(db, first.memory.id);
    const second = createMemory(db, { text: "soft delete then repeat" });
    assert.equal(second.deduped, false);
    assert.notEqual(second.memory.id, first.memory.id);
  });
});

test("dedupe: the same text after the first was superseded creates a new row", async () => {
  await withDbAsync(async (db) => {
    const first = createMemory(db, { text: "supersede then repeat" });
    await sleep(3);
    supersedeMemory(db, first.memory.id, { text: "replacement text" });
    const third = createMemory(db, { text: "supersede then repeat" });
    assert.equal(third.deduped, false);
    assert.notEqual(third.memory.id, first.memory.id);
  });
});

// withTempDir's cleanup runs synchronously right after its callback
// returns, so an async callback (one that returns a Promise) would have
// its temp dir removed before the awaited work inside it finishes. Manage
// the temp dir manually here instead for the async tests below.
async function withDbAsync<T>(fn: (db: CairnDb) => Promise<T>): Promise<T> {
  const dir = makeTempDir();
  const db = openDb({ path: tempDbPath(dir) });
  try {
    return await fn(db);
  } finally {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Best-effort: never mask the real failure from fn() with a cleanup error.
    }
  }
}

test("keyset pagination over 25 memories sharing one created_at visits every row exactly once", () => {
  withDb((db) => {
    const sharedCreatedAt = 1_700_000_000_000;
    const inserted: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      inserted.push(rawInsertMemory(db, { text: `shared-ts ${i}`, createdAt: sharedCreatedAt }));
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result = listMemories(db, { limit: 7, cursor });
      assert.ok(result.items.length <= 7);
      seen.push(...result.items.map((m) => m.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }

    assert.equal(seen.length, inserted.length);
    assert.deepEqual(new Set(seen), new Set(inserted));
  });
});

test("listMemories: limit defaults to 50 and clamps at 200", () => {
  withDb((db) => {
    db.tx(() => {
      for (let i = 0; i < 205; i += 1) {
        rawInsertMemory(db, { text: `bulk ${i}`, createdAt: 1_700_000_000_000 + i });
      }
    });

    const defaultPage = listMemories(db);
    assert.equal(defaultPage.items.length, 50);
    assert.ok(defaultPage.nextCursor !== null);

    const clamped = listMemories(db, { limit: 9999 });
    assert.equal(clamped.items.length, 200);
  });
});

test("listMemories: a malformed cursor throws", () => {
  withDb((db) => {
    assert.throws(() => listMemories(db, { cursor: "not-a-real-cursor" }), /malformed memories cursor/);
  });
});

test("listMemories: an empty-string cursor returns the first page, not an error", () => {
  withDb((db) => {
    const { memory } = createMemory(db, { text: "first page via empty cursor" });
    const result = listMemories(db, { cursor: "" });
    assert.equal(
      result.items.some((m) => m.id === memory.id),
      true,
    );
  });
});

test("soft delete hides a memory from listMemories; restore brings it back; the row is never physically removed", () => {
  withDb((db) => {
    const { memory } = createMemory(db, { text: "to be soft deleted" });

    assert.equal(softDeleteMemory(db, memory.id), true);
    assert.equal(
      listMemories(db).items.some((m) => m.id === memory.id),
      false,
    );
    assert.equal(
      listMemories(db, { includeDeleted: true }).items.some((m) => m.id === memory.id),
      true,
    );
    assert.equal(
      db.q("select count(*) as c from memories where id = ?").get(memory.id)?.["c"],
      1,
    );

    assert.equal(restoreMemory(db, memory.id), true);
    assert.equal(
      listMemories(db).items.some((m) => m.id === memory.id),
      true,
    );
  });
});

test("restoreMemory throws, naming both ids, when the text was re-remembered as a new row while deleted", () => {
  withDb((db) => {
    const { memory: original } = createMemory(db, { text: "I use vim" });
    softDeleteMemory(db, original.id);
    const { memory: replacement } = createMemory(db, { text: "I use vim" });
    assert.notEqual(replacement.id, original.id);

    assert.throws(
      () => restoreMemory(db, original.id),
      new RegExp(`${original.id}.*${replacement.id}`),
    );
  });
});

// This is the regression check for finding 1: without the
// `Math.max(..., validFrom + 1)` clamp in supersedeMemory, every one of
// these 50 back-to-back supersedes (run with NO artificial delay, so
// consecutive uuidv7 ids routinely share a millisecond) collapses its
// predecessor's valid_from/valid_until into a zero-width window, and the
// predecessor becomes invisible to memoriesAsOf at its own validFrom —
// tried by reverting the clamp to `valid_until = replacement.createdAt`,
// which reproduces exactly that failure.
test("supersede 50 times back-to-back with no delay: every superseded memory stays visible at its own validFrom", () => {
  withDb((db) => {
    let current = createMemory(db, { text: "v0" }).memory;
    const supersededIds: string[] = [];
    for (let i = 1; i <= 50; i += 1) {
      const { superseded, replacement } = supersedeMemory(db, current.id, { text: `v${i}` });
      supersededIds.push(superseded.id);
      current = replacement;
    }

    for (const id of supersededIds) {
      const old = getMemory(db, id);
      assert.ok(old);
      assert.ok(old && old.validUntil !== null && old.validUntil > old.validFrom);
      const atValidFrom = memoriesAsOf(db, old!.validFrom, { limit: 200 });
      assert.ok(
        atValidFrom.some((m) => m.id === id),
        `memory ${id} should be visible at its own validFrom`,
      );
    }
  });
});

test("supersede: old row gets valid_until and superseded_by, replacement is live, both rows still exist, memoriesAsOf reflects each side of the boundary", () => {
  withDb((db) => {
    const { memory: oldMemory } = createMemory(db, { text: "old fact" });
    const { superseded, replacement } = supersedeMemory(db, oldMemory.id, { text: "new fact" });

    assert.ok(superseded.validUntil !== null);
    assert.ok((superseded.validUntil as number) > superseded.validFrom);
    assert.equal(superseded.supersededBy, replacement.id);
    assert.equal(replacement.validUntil, null);
    assert.equal(replacement.supersededBy, null);

    assert.ok(getMemory(db, superseded.id));
    assert.ok(getMemory(db, replacement.id));

    const before = memoriesAsOf(db, oldMemory.validFrom);
    assert.ok(before.some((m) => m.id === oldMemory.id && m.text === "old fact"));

    const after = memoriesAsOf(db, superseded.validUntil as number);
    assert.ok(after.some((m) => m.id === replacement.id && m.text === "new fact"));
    assert.equal(after.some((m) => m.id === superseded.id), false);
  });
});

test("supersede throws when the id does not exist or is already superseded", () => {
  withDb((db) => {
    assert.throws(() => supersedeMemory(db, "no-such-id", { text: "x" }), /not found/);

    const { memory } = createMemory(db, { text: "will be superseded once" });
    supersedeMemory(db, memory.id, { text: "replacement" });
    assert.throws(
      () => supersedeMemory(db, memory.id, { text: "second replacement" }),
      /already superseded/,
    );
  });
});

test("supersedeMemory with the old row's own text succeeds", () => {
  withDb((db) => {
    const { memory } = createMemory(db, { text: "restate me" });
    const { superseded, replacement } = supersedeMemory(db, memory.id, { text: "restate me" });
    assert.equal(replacement.text, "restate me");
    assert.equal(superseded.supersededBy, replacement.id);
  });
});

test("supersedeMemory colliding with a different live memory throws, naming the conflicting id", () => {
  withDb((db) => {
    const { memory: a } = createMemory(db, { text: "will be superseded" });
    const { memory: b } = createMemory(db, { text: "already live text" });

    assert.throws(
      () => supersedeMemory(db, a.id, { text: "already live text" }),
      new RegExp(b.id),
    );
  });
});

test("touchMemory increments access_count, leaves updated_at untouched, and leaves the FTS index clean", () => {
  withDb((db) => {
    const { memory } = createMemory(db, { text: "touch me" });

    touchMemory(db, memory.id);
    touchMemory(db, memory.id);

    const reloaded = getMemory(db, memory.id);
    assert.ok(reloaded);
    assert.equal(reloaded?.accessCount, 2);
    assert.equal(reloaded?.updatedAt, memory.updatedAt);
    assert.ok(reloaded?.lastAccessed !== null);

    assert.doesNotThrow(() =>
      db.exec("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')"),
    );
  });
});

test("updateMemory colliding with another live memory throws, naming the conflicting id", () => {
  withDb((db) => {
    const { memory: a } = createMemory(db, { text: "alpha fact" });
    const { memory: b } = createMemory(db, { text: "beta fact" });

    assert.throws(
      () => updateMemory(db, b.id, { text: "alpha fact" }),
      new RegExp(a.id),
    );
  });
});

test("updateMemory updates text, tags, and importance without colliding with itself", () => {
  withDb((db) => {
    const { memory } = createMemory(db, { text: "original text", tags: ["a"], importance: 0.2 });
    const updated = updateMemory(db, memory.id, { text: "revised text", tags: ["b", "c"], importance: 0.9 });

    assert.equal(updated.text, "revised text");
    assert.deepEqual(updated.tags, ["b", "c"]);
    assert.equal(updated.importance, 0.9);
    assert.equal(updated.contentHash, contentHash("revised text"));
  });
});

test("updateMemory on a superseded row throws", () => {
  withDb((db) => {
    const { memory } = createMemory(db, { text: "will become history" });
    const { superseded } = supersedeMemory(db, memory.id, { text: "the new fact" });

    assert.throws(() => updateMemory(db, superseded.id, { text: "rewriting history" }), /superseded/);
  });
});

test("importance out of range throws on create, update, and supersede", () => {
  withDb((db) => {
    assert.throws(
      () => createMemory(db, { text: "bad importance", importance: 1.5 }),
      /importance must be between 0 and 1/,
    );

    const { memory } = createMemory(db, { text: "valid importance", importance: 0.5 });
    assert.throws(
      () => updateMemory(db, memory.id, { importance: -0.1 }),
      /importance must be between 0 and 1/,
    );
    assert.throws(
      () => supersedeMemory(db, memory.id, { text: "replacement", importance: Number.NaN }),
      /importance must be between 0 and 1/,
    );
  });
});

test("listMemories: includeSuperseded returns superseded rows; the default excludes them", () => {
  withDb((db) => {
    const { memory } = createMemory(db, { text: "will be superseded" });
    const { superseded } = supersedeMemory(db, memory.id, { text: "replacement fact" });

    assert.equal(
      listMemories(db).items.some((m) => m.id === superseded.id),
      false,
    );
    assert.equal(
      listMemories(db, { includeSuperseded: true }).items.some((m) => m.id === superseded.id),
      true,
    );
  });
});

test("Memory.seq is populated and matches the row's seq column", () => {
  withDb((db) => {
    const { memory } = createMemory(db, { text: "has a seq" });
    const row = db.q("select seq from memories where id = ?").get(memory.id);
    assert.equal(memory.seq, Number(row?.["seq"]));
  });
});

test("listMemories: tag filtering is AND, not OR", () => {
  withDb((db) => {
    const { memory: both } = createMemory(db, { text: "red and big", tags: ["red", "big"] });
    createMemory(db, { text: "just red", tags: ["red"] });
    createMemory(db, { text: "just big", tags: ["big"] });

    const result = listMemories(db, { tags: ["red", "big"] });
    assert.deepEqual(
      result.items.map((m) => m.id),
      [both.id],
    );
  });
});
