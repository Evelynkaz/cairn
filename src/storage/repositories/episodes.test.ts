import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempDir, tempDbPath } from "../../testing/tmp.js";
import { openDb } from "../db.js";
import type { CairnDb } from "../db.js";
import { timestampFromUuidv7 } from "../../util/id.js";
import { uuidv7 } from "../../util/id.js";
import { appendEpisode, getEpisode, importEpisode, listEpisodes } from "./episodes.js";
import { createMemory, getMemory } from "./memories.js";
import { clampLimit } from "./paging.js";

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

test("appendEpisode returns the row and created_at is derived from the id", () => {
  withDb((db) => {
    const episode = appendEpisode(db, {
      content: "user said the sky is blue",
      scope: "work",
      sourceClient: "claude-desktop",
      metadata: { channel: "chat" },
    });

    assert.equal(episode.content, "user said the sky is blue");
    assert.equal(episode.scope, "work");
    assert.equal(episode.sourceClient, "claude-desktop");
    assert.deepEqual(episode.metadata, { channel: "chat" });
    assert.equal(episode.createdAt, timestampFromUuidv7(episode.id));
  });
});

test("appendEpisode defaults scope, sourceClient, and metadata", () => {
  withDb((db) => {
    const episode = appendEpisode(db, { content: "hello" });
    assert.equal(episode.scope, "default");
    assert.equal(episode.sourceClient, null);
    assert.deepEqual(episode.metadata, {});
  });
});

test("getEpisode returns the appended episode; missing id returns undefined", () => {
  withDb((db) => {
    const episode = appendEpisode(db, { content: "hello there" });
    const fetched = getEpisode(db, episode.id);
    assert.deepEqual(fetched, episode);
    assert.equal(getEpisode(db, "00000000-0000-7000-8000-000000000000"), undefined);
  });
});

test("listEpisodes pagination visits every episode exactly once, in (created_at, id) desc order", () => {
  withDb((db) => {
    const inserted: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      inserted.push(appendEpisode(db, { content: `episode ${i}` }).id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result = listEpisodes(db, { limit: 5, cursor });
      assert.ok(result.items.length <= 5);
      seen.push(...result.items.map((e) => e.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }

    assert.equal(seen.length, inserted.length);
    assert.deepEqual(new Set(seen), new Set(inserted));
  });
});

test("listEpisodes: a malformed cursor throws", () => {
  withDb((db) => {
    assert.throws(() => listEpisodes(db, { cursor: "not-a-real-cursor" }), /malformed episodes cursor/);
  });
});

// Pins the dashboard's 400-vs-500 mapping (src/dashboard/api.ts's
// isMalformedCursorError): if this decoder's wording ever drifts from
// "malformed .*cursor", a bad cursor silently becomes a 500 instead of a
// 400. Duplicated literally (not imported) because isMalformedCursorError is
// not exported.
test("listEpisodes's malformed-cursor message matches the dashboard's isMalformedCursorError pattern", () => {
  withDb((db) => {
    assert.throws(() => listEpisodes(db, { cursor: "not-a-real-cursor" }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(/malformed .*cursor/i.test(err.message));
      return true;
    });
  });
});

test("listEpisodes: an empty-string cursor returns the first page, not an error", () => {
  withDb((db) => {
    const first = appendEpisode(db, { content: "a" });
    const result = listEpisodes(db, { cursor: "" });
    assert.equal(
      result.items.some((e) => e.id === first.id),
      true,
    );
  });
});

test("clampLimit: 0, NaN, and undefined default; 10.7 floors; 500 clamps to the max", () => {
  assert.equal(clampLimit(0), 50);
  assert.equal(clampLimit(Number.NaN), 50);
  assert.equal(clampLimit(undefined), 50);
  assert.equal(clampLimit(10.7), 10);
  assert.equal(clampLimit(500), 200);
});

test("listEpisodes filters by scope", () => {
  withDb((db) => {
    appendEpisode(db, { content: "a", scope: "work" });
    appendEpisode(db, { content: "b", scope: "home" });
    const result = listEpisodes(db, { scope: "work" });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.scope, "work");
  });
});

test("importEpisode inserts under the caller-supplied id, with created_at derived from it", () => {
  withDb((db) => {
    const id = uuidv7();
    const result = importEpisode(db, {
      id,
      content: "imported content",
      scope: "work",
      sourceClient: "claude-desktop",
      metadata: { channel: "chat" },
    });

    assert.equal(result.skipped, false);
    assert.ok(result.episode);
    assert.equal(result.episode?.id, id);
    assert.equal(result.episode?.content, "imported content");
    assert.equal(result.episode?.scope, "work");
    assert.equal(result.episode?.sourceClient, "claude-desktop");
    assert.deepEqual(result.episode?.metadata, { channel: "chat" });
    assert.equal(result.episode?.createdAt, timestampFromUuidv7(id));
  });
});

test("importEpisode: an id already present is skipped, never overwritten", () => {
  withDb((db) => {
    const original = appendEpisode(db, { content: "original" });

    const result = importEpisode(db, { id: original.id, content: "attempted overwrite" });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "duplicate-id");
    assert.equal(result.episode, undefined);
    assert.deepEqual(getEpisode(db, original.id), original);
  });
});

test("importEpisode: re-importing the same archive line twice is a no-op the second time", () => {
  withDb((db) => {
    const id = uuidv7();
    const first = importEpisode(db, { id, content: "only once" });
    assert.equal(first.skipped, false);

    const second = importEpisode(db, { id, content: "only once" });
    assert.equal(second.skipped, true);
    assert.equal(second.reason, "duplicate-id");
  });
});

test("importEpisode: a malformed uuidv7 is refused, not stored", () => {
  withDb((db) => {
    assert.throws(
      () => importEpisode(db, { id: "not-a-real-uuid", content: "nope" }),
      /not a canonical UUIDv7/,
    );
    const row = db.q(`SELECT COUNT(*) AS c FROM episodes`).get();
    assert.equal(row?.["c"], 0);
  });
});

// Builds a well-formed uuidv7-shaped id whose embedded 48-bit timestamp is
// exactly `ms`, for exercising the future-skew bound precisely.
function idAtTimestamp(ms: number): string {
  const hex = BigInt(Math.trunc(ms)).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}

test("importEpisode: an id whose timestamp is far in the future is refused", () => {
  withDb((db) => {
    const farFutureId = idAtTimestamp(Date.UTC(9999, 0, 1));
    assert.throws(() => importEpisode(db, { id: farFutureId, content: "far future" }));
    const count = db.q("select count(*) as c from episodes").get()?.["c"];
    assert.equal(count, 0);
  });
});

test("importEpisode: an id a few seconds ahead of now is accepted (clock skew)", () => {
  withDb((db) => {
    const slightlyAheadId = idAtTimestamp(Date.now() + 5_000);
    const result = importEpisode(db, { id: slightlyAheadId, content: "slightly ahead" });
    assert.equal(result.skipped, false);
  });
});

test("a memory linked via episode_id survives episode deletion, with episode_id set to NULL", () => {
  withDb((db) => {
    const episode = appendEpisode(db, { content: "source text" });
    const { memory } = createMemory(db, { text: "derived fact", episodeId: episode.id });
    assert.equal(memory.episodeId, episode.id);

    db.q("DELETE FROM episodes WHERE id = ?").run(episode.id);

    const reloaded = getMemory(db, memory.id);
    assert.ok(reloaded);
    assert.equal(reloaded?.episodeId, null);
  });
});

// Regression for a hostile-input finding (BUILD_BRIEF §10/§12): an
// attacker-controlled id (an archive's episode id) must never be echoed
// unbounded into an error message that can surface all the way into an MCP
// client's context. Mirrors memories.test.ts's equivalent importMemory test.
test("importEpisode: a 500,000-character id produces a bounded message, not an unbounded echo", () => {
  withDb((db) => {
    const hugeId = "Q".repeat(500_000);
    assert.throws(() => importEpisode(db, { id: hugeId, content: "x" }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.length < 200, `expected a bounded message, got length ${err.message.length}`);
      return true;
    });
  });
});

test("importEpisode: an id embedding an implausible future timestamp produces a bounded message", () => {
  withDb((db) => {
    const farFutureId = idAtTimestamp(Date.UTC(9999, 0, 1));
    assert.throws(() => importEpisode(db, { id: farFutureId, content: "x" }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.length < 200, `expected a bounded message, got length ${err.message.length}`);
      return true;
    });
  });
});
