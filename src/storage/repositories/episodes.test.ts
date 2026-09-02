import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempDir, tempDbPath } from "../../testing/tmp.js";
import { openDb } from "../db.js";
import type { CairnDb } from "../db.js";
import { timestampFromUuidv7 } from "../../util/id.js";
import { appendEpisode, getEpisode, listEpisodes } from "./episodes.js";
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
