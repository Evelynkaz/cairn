import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { withTempDir, makeTempDir, tempDbPath } from "../../testing/tmp.js";
import { openDb } from "../db.js";
import type { CairnDb } from "../db.js";
import { timestampFromUuidv7, uuidv7 } from "../../util/id.js";
import { contentHash } from "../../util/text.js";
import {
  LiveTextCollisionError,
  createMemory,
  getMemory,
  importMemory,
  listMemories,
  memoriesAsOf,
  restoreMemory,
  setMemoryApproved,
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
  overrides: Partial<{
    id: string;
    text: string;
    scope: string;
    sourceClient: string | null;
    createdAt: number;
    updatedAt: number;
    contentHash: string;
  }> = {},
): string {
  const id = overrides.id ?? uuidv7();
  const createdAt = overrides.createdAt ?? timestampFromUuidv7(id);
  // Defaults to createdAt like the rest of this fixture, but a caller can
  // diverge it -- a row that has been "edited" has updated_at > created_at,
  // and several tests below need that divergence to be visible at all.
  const updatedAt = overrides.updatedAt ?? createdAt;
  const text = overrides.text ?? id;
  db.q(
    `INSERT INTO memories (id, text, scope, source_client, importance, created_at, updated_at, valid_from, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    text,
    overrides.scope ?? "default",
    overrides.sourceClient ?? null,
    0.5,
    createdAt,
    updatedAt,
    createdAt,
    overrides.contentHash ?? contentHash(text),
  );
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

test("soft delete and restore of an imported memory leaves its origin 'import' and unapproved throughout", () => {
  withDb((db) => {
    const imported = importMemory(db, { id: uuidv7(), text: "to be forgotten and restored" }).memory!;
    assert.equal(imported.origin, "import");
    assert.equal(imported.approved, false);

    assert.equal(softDeleteMemory(db, imported.id), true);
    assert.equal(getMemory(db, imported.id)?.origin, "import");
    assert.equal(getMemory(db, imported.id)?.approved, false);

    assert.equal(restoreMemory(db, imported.id), true);
    assert.equal(getMemory(db, imported.id)?.origin, "import");
    assert.equal(getMemory(db, imported.id)?.approved, false);
  });
});

test("restoreMemory throws a typed LiveTextCollisionError, naming both ids, when the text was re-remembered as a new row while deleted", () => {
  withDb((db) => {
    const { memory: original } = createMemory(db, { text: "I use vim" });
    softDeleteMemory(db, original.id);
    const { memory: replacement } = createMemory(db, { text: "I use vim" });
    assert.notEqual(replacement.id, original.id);

    assert.throws(
      () => restoreMemory(db, original.id),
      new RegExp(`${original.id}.*${replacement.id}`),
    );
    try {
      restoreMemory(db, original.id);
      assert.fail("expected restoreMemory to throw");
    } catch (err) {
      assert.ok(err instanceof LiveTextCollisionError);
      assert.equal(err.conflictingId, replacement.id);
    }
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

// Regression for finding 1's actual defect: not just "the old row stays
// visible at its own validFrom" (checked above), but that the two
// intervals never OVERLAP. Without inserting the replacement's valid_from
// at the clamped valid_until (instead of createdAt), a same-millisecond
// supersede makes both the old and new memory live at the boundary
// millisecond -- asOf(old.validFrom) would return both "vN" and "vN+1"
// instead of exactly one. Reverting the fix (replacement valid_from back to
// createdAt) reproduces exactly that: this test fails with two ids returned
// where one is expected.
test("supersede back-to-back with no delay: at every boundary millisecond, asOf returns exactly one of the two facts, never both, never neither", () => {
  withDb((db) => {
    let current = createMemory(db, { text: "v0" }).memory;
    const steps: { oldId: string; newId: string; validFrom: number; validUntil: number }[] = [];
    for (let i = 1; i <= 50; i += 1) {
      const { superseded, replacement } = supersedeMemory(db, current.id, { text: `v${i}` });
      steps.push({
        oldId: superseded.id,
        newId: replacement.id,
        validFrom: superseded.validFrom,
        validUntil: superseded.validUntil as number,
      });
      current = replacement;
    }

    for (const step of steps) {
      const atPredecessorBoundary = memoriesAsOf(db, step.validUntil - 1, { limit: 200 });
      const predecessorIds = new Set(atPredecessorBoundary.map((m) => m.id));
      assert.equal(predecessorIds.has(step.oldId), true, `old ${step.oldId} should be live at validUntil - 1`);
      assert.equal(predecessorIds.has(step.newId), false, `new ${step.newId} must not be live before its own validFrom`);

      const atSuccessorBoundary = memoriesAsOf(db, step.validUntil, { limit: 200 });
      const successorIds = new Set(atSuccessorBoundary.map((m) => m.id));
      assert.equal(successorIds.has(step.newId), true, `new ${step.newId} should be live at its own validFrom`);
      assert.equal(successorIds.has(step.oldId), false, `old ${step.oldId} must no longer be live at validUntil`);
    }
  });
});

// Regression: a multi-step chain must hand off with neither a gap (a
// millisecond where nothing from the chain is live) nor an overlap (a
// millisecond where two links are simultaneously live).
test("a three-step supersede chain hands off with no gap and no overlap at every boundary", () => {
  withDb((db) => {
    const v0 = createMemory(db, { text: "chain v0" }).memory;
    const step1 = supersedeMemory(db, v0.id, { text: "chain v1" });
    const step2 = supersedeMemory(db, step1.replacement.id, { text: "chain v2" });
    const step3 = supersedeMemory(db, step2.replacement.id, { text: "chain v3" });

    const chain = [
      { id: v0.id, validFrom: v0.validFrom, validUntil: step1.superseded.validUntil as number },
      { id: step1.replacement.id, validFrom: step1.replacement.validFrom, validUntil: step2.superseded.validUntil as number },
      { id: step2.replacement.id, validFrom: step2.replacement.validFrom, validUntil: step3.superseded.validUntil as number },
      { id: step3.replacement.id, validFrom: step3.replacement.validFrom, validUntil: null as number | null },
    ];

    // No gap, no overlap: each link's validFrom must equal the previous
    // link's validUntil exactly.
    for (let i = 1; i < chain.length; i += 1) {
      assert.equal(chain[i]!.validFrom, chain[i - 1]!.validUntil, `link ${i} must start exactly where link ${i - 1} ends`);
    }

    for (let i = 0; i < chain.length; i += 1) {
      const link = chain[i]!;
      // Live at its own validFrom, and nowhere else in the chain is.
      const atStart = memoriesAsOf(db, link.validFrom, { limit: 200 });
      const startIds = new Set(atStart.map((m) => m.id));
      assert.equal(startIds.has(link.id), true, `link ${i} should be live at its own validFrom`);
      for (let j = 0; j < chain.length; j += 1) {
        if (j !== i) {
          assert.equal(startIds.has(chain[j]!.id), false, `link ${j} must not be live at link ${i}'s validFrom`);
        }
      }
      // Live at validUntil - 1 (last millisecond it's live), gone at validUntil.
      if (link.validUntil !== null) {
        const atLast = memoriesAsOf(db, link.validUntil - 1, { limit: 200 });
        assert.equal(
          new Set(atLast.map((m) => m.id)).has(link.id),
          true,
          `link ${i} should still be live at validUntil - 1`,
        );
        const atEnd = memoriesAsOf(db, link.validUntil, { limit: 200 });
        assert.equal(
          new Set(atEnd.map((m) => m.id)).has(link.id),
          false,
          `link ${i} must not be live at its own validUntil`,
        );
      }
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

test("supersedeMemory colliding with a different live memory throws a typed LiveTextCollisionError naming the conflicting id", () => {
  withDb((db) => {
    const { memory: a } = createMemory(db, { text: "will be superseded" });
    const { memory: b } = createMemory(db, { text: "already live text" });

    assert.throws(
      () => supersedeMemory(db, a.id, { text: "already live text" }),
      new RegExp(b.id),
    );
    try {
      supersedeMemory(db, a.id, { text: "already live text" });
      assert.fail("expected supersedeMemory to throw");
    } catch (err) {
      // Callers (the dashboard API) must be able to detect this
      // structurally, not by matching this error's message text -- that
      // message is free to change and has already drifted once.
      assert.ok(err instanceof LiveTextCollisionError);
      assert.equal(err.code, "live_text_collision");
      assert.equal(err.conflictingId, b.id);
    }
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

test("updateMemory colliding with another live memory throws a typed LiveTextCollisionError naming the conflicting id", () => {
  withDb((db) => {
    const { memory: a } = createMemory(db, { text: "alpha fact" });
    const { memory: b } = createMemory(db, { text: "beta fact" });

    assert.throws(
      () => updateMemory(db, b.id, { text: "alpha fact" }),
      new RegExp(a.id),
    );
    try {
      updateMemory(db, b.id, { text: "alpha fact" });
      assert.fail("expected updateMemory to throw");
    } catch (err) {
      assert.ok(err instanceof LiveTextCollisionError);
      assert.equal(err.code, "live_text_collision");
      assert.equal(err.conflictingId, a.id);
    }
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

test("listMemories: sourceClient filters exactly that client", () => {
  withDb((db) => {
    const mine = rawInsertMemory(db, { text: "mine", sourceClient: "app-a" });
    rawInsertMemory(db, { text: "not mine", sourceClient: "app-b" });
    rawInsertMemory(db, { text: "anonymous" });

    const result = listMemories(db, { sourceClient: "app-a" });
    assert.deepEqual(result.items.map((m) => m.id), [mine]);
  });
});

test("listMemories: since is inclusive, until is exclusive", () => {
  withDb((db) => {
    const before = rawInsertMemory(db, { text: "before", createdAt: 1000 });
    const atSince = rawInsertMemory(db, { text: "at since", createdAt: 2000 });
    const inRange = rawInsertMemory(db, { text: "in range", createdAt: 2500 });
    const atUntil = rawInsertMemory(db, { text: "at until", createdAt: 3000 });
    const after = rawInsertMemory(db, { text: "after", createdAt: 4000 });

    const result = listMemories(db, { since: 2000, until: 3000 });
    const ids = new Set(result.items.map((m) => m.id));
    assert.equal(ids.has(before), false);
    assert.equal(ids.has(atSince), true);
    assert.equal(ids.has(inRange), true);
    assert.equal(ids.has(atUntil), false);
    assert.equal(ids.has(after), false);
  });
});

// Regression for the concern that the since/until filter and the
// ORDER BY/keyset cursor could end up reading two different clocks
// (created_at for the filter, updated_at for the sort/cursor). listMemories
// uses created_at for all three, so a row's updated_at must have zero
// effect on whether it is included or where it sorts -- these fixtures
// deliberately set updated_at far from created_at, including on rows that
// straddle the since/until boundary on one clock but not the other, so a
// regression that started reading updated_at anywhere in this path would
// show up as a wrong inclusion/exclusion or a wrong order here.
test("listMemories: since/until and ordering are governed by created_at, never by updated_at", () => {
  withDb((db) => {
    // In range on created_at, but "edited" long after the until boundary --
    // must still be included and must not be pulled to the front by that
    // late updated_at, since ordering does not use updated_at either.
    const editedAfterWindow = rawInsertMemory(db, {
      text: "in range, edited after until",
      createdAt: 2000,
      updatedAt: 9000,
    });
    // Out of range on created_at (>= until), but "edited" so its updated_at
    // falls inside [since, until) -- must still be excluded.
    const outOfRangeUpdatedInWindow = rawInsertMemory(db, {
      text: "out of range, updated_at inside window",
      createdAt: 3500,
      updatedAt: 2500,
    });
    // Out of range on created_at (< since), but "edited" so its updated_at
    // falls inside [since, until) -- must still be excluded.
    const beforeRangeUpdatedInWindow = rawInsertMemory(db, {
      text: "before range, updated_at inside window",
      createdAt: 800,
      updatedAt: 2200,
    });
    // A normal in-range row, unedited, to check relative ordering against
    // editedAfterWindow.
    const normalInRange = rawInsertMemory(db, {
      text: "in range, unedited",
      createdAt: 2400,
      updatedAt: 2400,
    });

    const result = listMemories(db, { since: 2000, until: 3000 });
    const ids = result.items.map((m) => m.id);
    assert.deepEqual(new Set(ids), new Set([editedAfterWindow, normalInRange]));
    assert.equal(ids.includes(outOfRangeUpdatedInWindow), false);
    assert.equal(ids.includes(beforeRangeUpdatedInWindow), false);
    // Ordering must follow created_at (2400 before 2000), not updated_at
    // (which would put editedAfterWindow, updated_at 9000, first).
    assert.deepEqual(ids, [normalInRange, editedAfterWindow]);
  });
});

test("listMemories: scope, tags, sourceClient, and since/until compose with AND", () => {
  withDb((db) => {
    const { memory } = createMemory(db, {
      text: "matches every filter",
      scope: "work",
      tags: ["urgent"],
    });
    db.q(`UPDATE memories SET source_client = ? WHERE id = ?`).run("app-a", memory.id);

    createMemory(db, { text: "wrong scope", scope: "personal", tags: ["urgent"] });
    createMemory(db, { text: "wrong tag", scope: "work", tags: ["later"] });
    const { memory: wrongClient } = createMemory(db, { text: "wrong client", scope: "work", tags: ["urgent"] });
    db.q(`UPDATE memories SET source_client = ? WHERE id = ?`).run("app-b", wrongClient.id);

    const result = listMemories(db, {
      scope: "work",
      tags: ["urgent"],
      sourceClient: "app-a",
      since: memory.createdAt,
      until: memory.createdAt + 1,
    });
    assert.deepEqual(result.items.map((m) => m.id), [memory.id]);
  });
});

// The important regression: a caller-supplied created_at range and the
// keyset cursor's own (created_at, id) comparison are two independent AND
// terms. Mixing 60 matching rows (a third of which share one created_at,
// to stress the tuple comparison) with 60 non-matching rows across a page
// size that forces at least 3 pages, and checking every matching row was
// seen exactly once, is the case a naive `created_at < ?`-only cursor (or
// a merged/collapsed range+cursor predicate) gets wrong. updated_at is
// deliberately scattered far from created_at on every row (including ones
// that straddle the `since` boundary on one clock but not the other), so a
// regression that started ordering, cursoring, or filtering by updated_at
// anywhere in this path would surface as a skipped/repeated/wrongly
// included row here, not just in a single-page test.
test("keyset pagination through a filtered result set visits every matching row exactly once, and no non-matching row", () => {
  withDb((db) => {
    const sharedTs = 1_700_000_000_000;
    const matching = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      matching.add(
        rawInsertMemory(db, {
          text: `match shared ${i}`,
          sourceClient: "app-a",
          createdAt: sharedTs,
          updatedAt: sharedTs + 1_000_000 - i,
        }),
      );
    }
    for (let i = 0; i < 40; i += 1) {
      matching.add(
        rawInsertMemory(db, {
          text: `match spread ${i}`,
          sourceClient: "app-a",
          createdAt: sharedTs + 1 + i,
          updatedAt: sharedTs - 1_000_000 - i,
        }),
      );
    }
    // Non-matching rows interleaved across the same timestamp range, some
    // sharing the same created_at as matching rows, to make sure the
    // sourceClient predicate -- not just the range -- survives paging.
    // updated_at is set INSIDE the [since, ...) window even though
    // created_at is not, so a filter that read updated_at would wrongly
    // include these.
    for (let i = 0; i < 30; i += 1) {
      rawInsertMemory(db, {
        text: `other client ${i}`,
        sourceClient: "app-b",
        createdAt: sharedTs + i,
        updatedAt: sharedTs + i,
      });
    }
    for (let i = 0; i < 30; i += 1) {
      rawInsertMemory(db, {
        text: `outside range ${i}`,
        sourceClient: "app-a",
        createdAt: sharedTs - 100 - i,
        updatedAt: sharedTs + i,
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (let page = 0; page < 50; page += 1) {
      const result = listMemories(db, { sourceClient: "app-a", since: sharedTs, limit: 7, cursor });
      assert.ok(result.items.length <= 7);
      for (const item of result.items) {
        assert.equal(item.sourceClient, "app-a");
        assert.ok(item.createdAt >= sharedTs);
      }
      seen.push(...result.items.map((m) => m.id));
      cursor = result.nextCursor;
      pages += 1;
      if (cursor === null) break;
    }

    assert.ok(pages >= 3, `expected at least 3 pages, got ${pages}`);
    assert.equal(seen.length, matching.size);
    assert.equal(new Set(seen).size, seen.length, "no row was repeated across pages");
    assert.deepEqual(new Set(seen), matching);
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

test("importMemory: created_at is derived from the given id, not from Date.now()", () => {
  withDb((db) => {
    const oldId = uuidv7();
    const result = importMemory(db, { id: oldId, text: "an old fact", tags: ["b", "a"] });
    assert.equal(result.skipped, false);
    assert.equal(result.memory?.id, oldId);
    assert.equal(result.memory?.createdAt, timestampFromUuidv7(oldId));
    assert.deepEqual(result.memory?.tags, ["a", "b"]);
  });
});

test("importMemory: re-importing the same id is a no-op the second time", () => {
  withDb((db) => {
    const id = uuidv7();
    const first = importMemory(db, { id, text: "imported once" });
    assert.equal(first.skipped, false);

    const second = importMemory(db, { id, text: "imported once" });
    assert.equal(second.skipped, true);
    assert.equal(second.reason, "duplicate-id");

    const count = db.q("select count(*) as c from memories").get()?.["c"];
    assert.equal(count, 1);
  });
});

test("importMemory: content already live in the same scope is skipped, not duplicated", () => {
  withDb((db) => {
    createMemory(db, { text: "already live text", scope: "work" });

    const result = importMemory(db, { id: uuidv7(), text: "already live text", scope: "work" });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "duplicate-content");

    const count = db.q("select count(*) as c from memories").get()?.["c"];
    assert.equal(count, 1);
  });
});

test("importMemory: a malformed id is refused, not stored", () => {
  withDb((db) => {
    assert.throws(() => importMemory(db, { id: "not-a-uuid", text: "bad id" }));
    const count = db.q("select count(*) as c from memories").get()?.["c"];
    assert.equal(count, 0);
  });
});

test("importMemory: an id embedding an implausible timestamp is refused", () => {
  withDb((db) => {
    // A uuidv7 whose timestamp bits encode 1970-01-01: well-formed, but not
    // a plausible export from a Cairn store.
    const ancientId = "00000000-0000-7000-8000-000000000000";
    assert.throws(() => importMemory(db, { id: ancientId, text: "ancient" }));
    const count = db.q("select count(*) as c from memories").get()?.["c"];
    assert.equal(count, 0);
  });
});

// Builds a well-formed uuidv7-shaped id whose embedded 48-bit timestamp is
// exactly `ms`, for exercising the future-skew bound precisely.
function idAtTimestamp(ms: number): string {
  const hex = BigInt(Math.trunc(ms)).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}

test("importMemory: an id whose timestamp is far in the future is refused", () => {
  withDb((db) => {
    const farFutureId = idAtTimestamp(Date.UTC(9999, 0, 1));
    assert.throws(() => importMemory(db, { id: farFutureId, text: "far future" }));
    const count = db.q("select count(*) as c from memories").get()?.["c"];
    assert.equal(count, 0);
  });
});

test("importMemory: an id a few seconds ahead of now is accepted (clock skew)", () => {
  withDb((db) => {
    const slightlyAheadId = idAtTimestamp(Date.now() + 5_000);
    const result = importMemory(db, { id: slightlyAheadId, text: "slightly ahead" });
    assert.equal(result.skipped, false);
  });
});

// Regression for finding 2: the row is inserted before supersededBy is
// wired up, so a naive existence check run afterwards finds the
// just-inserted row itself and accepts a self-referential supersededBy.
// That leaves the memory live and editable forever, because
// supersedeMemory refuses any row whose superseded_by is already set --
// permanently un-supersedable. A hand-edited archive could plant exactly
// this.
test("importMemory: a self-referential supersededBy is rejected or nulled, and the memory can still be superseded normally afterward", () => {
  withDb((db) => {
    const id = uuidv7();
    const result = importMemory(db, { id, text: "self-referential", supersededBy: id });
    assert.equal(result.skipped, false);
    assert.notEqual(result.memory?.supersededBy, id);
    assert.equal(result.memory?.validUntil, null);

    // If it were left permanently un-supersedable, this would throw
    // "already superseded".
    const { superseded, replacement } = supersedeMemory(db, id, { text: "replacement text" });
    assert.equal(superseded.supersededBy, replacement.id);
    assert.ok(superseded.validUntil !== null);
  });
});

test("importMemory: tags, scope, importance and sourceClient all survive", () => {
  withDb((db) => {
    const id = uuidv7();
    const result = importMemory(db, {
      id,
      text: "full fidelity",
      scope: "work",
      tags: ["x", "y"],
      importance: 0.9,
      sourceClient: "claude",
    });
    assert.equal(result.skipped, false);
    assert.equal(result.memory?.scope, "work");
    assert.deepEqual(result.memory?.tags, ["x", "y"]);
    assert.equal(result.memory?.importance, 0.9);
    assert.equal(result.memory?.sourceClient, "claude");
  });
});

// Regression for a hostile-input finding (BUILD_BRIEF §10/§12): an
// attacker-controlled id (a tool argument, or an archive's memory id) must
// never be echoed unbounded into an error message that can surface all the
// way into an MCP client's context.
test("updateMemory: a 500,000-character id produces a bounded 'not found' message, not an unbounded echo", () => {
  withDb((db) => {
    const hugeId = "Q".repeat(500_000);
    assert.throws(() => updateMemory(db, hugeId, { text: "x" }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.length < 200, `expected a bounded message, got length ${err.message.length}`);
      return true;
    });
  });
});

test("importMemory: an id embedding an implausible timestamp produces a bounded message even when the id itself is huge", () => {
  withDb((db) => {
    const hugeId = "Q".repeat(500_000);
    assert.throws(() => importMemory(db, { id: hugeId, text: "x" }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.length < 200, `expected a bounded message, got length ${err.message.length}`);
      return true;
    });
  });
});

// BUILD_BRIEF §10/§14 provenance (migrations/004-provenance.ts): a direct
// createMemory (what `remember` calls) is 'user'-origin by default, and
// never pre-approved -- 'user' origin does not need it.
test("createMemory defaults to origin 'user', approved false", () => {
  withDb((db) => {
    const { memory } = createMemory(db, { text: "typed directly" });
    assert.equal(memory.origin, "user");
    assert.equal(memory.approved, false);
  });
});

// importMemory always stamps 'import' and approved false, and NEVER trusts
// a caller-supplied claim to the contrary -- a crafted archive setting
// `approved: true` on itself must not self-certify as trusted, or the
// entire point of this column is defeated. importMemory's own input type
// has no `approved`/`origin` fields at all, so this also checks that a
// caller cannot smuggle either past TypeScript via an `as` cast.
test("importMemory always stamps origin 'import' and approved false, regardless of any extra input fields", () => {
  withDb((db) => {
    const result = importMemory(db, {
      id: uuidv7(),
      text: "arrived via import",
      ...({ origin: "user", approved: true } as Record<string, unknown>),
    });
    assert.equal(result.skipped, false);
    assert.equal(result.memory?.origin, "import");
    assert.equal(result.memory?.approved, false);
  });
});

// createMemory's dedupe branch: a user typing the same text a `remember`
// call already saw imported must end up trusted -- an import happening to
// say the same thing first must not permanently exclude the user's own
// words from session-start injection.
test("createMemory dedupe: a live 'remember' of text that already exists as an import promotes the row to origin 'user'", () => {
  withDb((db) => {
    const imported = importMemory(db, { id: uuidv7(), text: "shared text" }).memory!;
    assert.equal(imported.origin, "import");

    const { memory, deduped } = createMemory(db, { text: "shared text" });
    assert.equal(deduped, true);
    assert.equal(memory.id, imported.id);
    assert.equal(memory.origin, "user");
    assert.equal(getMemory(db, imported.id)?.origin, "user");
  });
});

// The dedupe promotion must not fire when the colliding write itself is not
// 'user' origin (i.e. it never demotes, and only promotes on the specific
// signal defect 1 targets).
test("createMemory dedupe: a non-'user' origin write does not demote an already-'user' row", () => {
  withDb((db) => {
    const { memory: original } = createMemory(db, { text: "already trusted" });
    assert.equal(original.origin, "user");

    const { memory, deduped } = createMemory(db, { text: "already trusted", origin: "import" });
    assert.equal(deduped, true);
    assert.equal(memory.origin, "user", "must not demote an existing 'user' row");
  });
});

// updateMemory: `update_memory` is a model-callable MCP tool with no human
// in the loop, so a text replacement must NOT promote origin -- otherwise a
// poisoned imported memory could instruct the model to "fix the typo" and
// launder itself into 'user' (auto-injected at every SessionStart). Trust
// only ever comes from the explicit approve action (setMemoryApproved). A
// tags/importance-only patch also must not touch origin.
test("updateMemory: neither a text replacement nor a tags-only patch promotes origin", () => {
  withDb((db) => {
    const imported = importMemory(db, { id: uuidv7(), text: "from an import" }).memory!;
    assert.equal(imported.origin, "import");

    const tagged = updateMemory(db, imported.id, { tags: ["x"] });
    assert.equal(tagged.origin, "import", "a tags-only patch must not touch origin");

    const edited = updateMemory(db, imported.id, { text: "rewritten by the caller" });
    assert.equal(edited.origin, "import", "update_memory must not launder import origin to 'user'");
  });
});

// supersedeMemory: the replacement's text is fresh input from THIS call's
// caller (the dashboard's edit-and-supersede flow), so it is stamped
// 'user' regardless of the predecessor's own origin. The superseded
// (predecessor) row is history (§5) and keeps its own origin untouched.
test("supersedeMemory: the replacement is stamped origin 'user'; the superseded predecessor's origin is untouched", () => {
  withDb((db) => {
    const imported = importMemory(db, { id: uuidv7(), text: "predecessor from an import" }).memory!;
    const { superseded, replacement } = supersedeMemory(db, imported.id, { text: "fresh replacement text" });
    assert.equal(superseded.origin, "import", "the superseded row's own origin must not be rewritten");
    assert.equal(replacement.origin, "user");
  });
});

test("setMemoryApproved flips the approved flag and throws for a missing id", () => {
  withDb((db) => {
    const imported = importMemory(db, { id: uuidv7(), text: "needs review" }).memory!;
    assert.equal(imported.approved, false);

    const approved = setMemoryApproved(db, imported.id, true);
    assert.equal(approved.approved, true);
    assert.equal(getMemory(db, imported.id)?.approved, true);

    const revoked = setMemoryApproved(db, imported.id, false);
    assert.equal(revoked.approved, false);

    assert.throws(() => setMemoryApproved(db, "does-not-exist", true), /not found/);
  });
});

// Pre-existing rows predate origin/approved entirely (migrations/
// 004-provenance.ts): a raw row inserted before this column existed gets
// the honest 'unknown' default and approved=0, exactly like a fresh row
// that never specifies either -- proven here directly against the schema
// default rather than the migration path (migrations.test.ts covers the
// migration itself).
test("a row with no origin/approved specified gets the schema's honest defaults ('unknown', false)", () => {
  withDb((db) => {
    const id = uuidv7();
    const now = Date.now();
    db.q(
      `INSERT INTO memories (id, text, scope, created_at, updated_at, valid_from, content_hash)
       VALUES (?, ?, 'default', ?, ?, ?, ?)`,
    ).run(id, "predates provenance", now, now, now, contentHash("predates provenance"));
    const row = getMemory(db, id);
    assert.equal(row?.origin, "unknown");
    assert.equal(row?.approved, false);
  });
});
