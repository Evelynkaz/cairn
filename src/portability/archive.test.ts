import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir, makeTempDir, tempDbPath } from "../testing/tmp.js";
import { rmSync } from "node:fs";
import { openStore } from "../storage/index.js";
import type { Store } from "../storage/index.js";
import { readZip, writeZip } from "./zip.js";
import { exportArchive, importArchive, ArchiveFormatError } from "./archive.js";

function withStore<T>(fn: (store: Store) => T): T {
  return withTempDir((dir) => {
    const store = openStore({ path: tempDbPath(dir) });
    try {
      return fn(store);
    } finally {
      store.close();
    }
  });
}

// withTempDir's cleanup runs synchronously right after its callback
// returns, so an async callback would have its temp dir removed (and its
// store closed) before the awaited work inside it finishes. This variant
// awaits `fn` itself before cleaning up -- same pattern as store.test.ts's
// withStoreAsync.
async function withStoreAsync<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const dir = makeTempDir();
  const store = openStore({ path: tempDbPath(dir) });
  try {
    return await fn(store);
  } finally {
    store.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Best-effort: never mask the real failure from fn() with a cleanup error.
    }
  }
}

// Forces the next Date.now() (and therefore the next uuidv7()) onto a
// later millisecond, so memories remembered on either side of this call
// get clearly distinct created_at values instead of possibly sharing one.
function waitForNextMs(): void {
  const start = Date.now();
  while (Date.now() === start) {
    // busy-wait
  }
}

function which(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAVE_UNZIP = which("unzip");

function countAllMemories(store: Store): number {
  const row = store.db.q(`select count(*) as c from memories`).get();
  return row ? Number(row["c"]) : 0;
}

// Flips one byte inside a named entry after the archive has been built, so
// the CRC-32 the ZIP layer itself checks still passes (we rebuild the ZIP
// around the tampered bytes) but the SHA256 this module's manifest records
// no longer matches -- this is what an archive corrupted or tampered with
// AFTER export, but not IN TRANSIT as a zip, looks like.
function tamperEntry(archive: Buffer, name: string): Buffer {
  const entries = readZip(archive);
  const target = entries.find((e) => e.name === name);
  if (!target || target.data.length === 0) {
    throw new Error(`test setup: cannot tamper with ${name}`);
  }
  const tampered = Buffer.from(target.data);
  tampered[0] = (tampered[0]! + 1) % 256;
  return writeZip(
    entries.map((e) => (e.name === name ? { name: e.name, data: tampered } : e)),
  );
}

test("round trip preserves chronology: same ids, same createdAt, into a fresh store", () => {
  withStore((source) => {
    const first = source.remember({ content: "first fact" }).memory;
    waitForNextMs();
    const second = source.remember({ content: "second fact" }).memory;
    waitForNextMs();
    const third = source.remember({ content: "third fact" }).memory;

    assert.ok(first.createdAt < second.createdAt);
    assert.ok(second.createdAt < third.createdAt);

    const { archive } = exportArchive(source);

    withStore((dest) => {
      const result = importArchive(dest, archive);
      assert.equal(result.imported, 3);
      assert.equal(result.skipped, 0);

      for (const original of [first, second, third]) {
        const imported = dest.get(original.id, {});
        assert.ok(imported, `memory ${original.id} was not imported`);
        assert.equal(imported.id, original.id);
        assert.equal(imported.createdAt, original.createdAt);
      }
    });
  });
});

test("re-importing the same archive into the same store imports nothing the second time", () => {
  withStore((store) => {
    store.remember({ content: "only once" });
    const { archive } = exportArchive(store);

    const first = importArchive(store, archive);
    assert.equal(first.imported, 0); // already live in this same store
    assert.equal(first.skipped, 1);
    assert.equal(first.episodesImported, 0); // already live from remember() above
    assert.equal(first.episodesSkipped, 1);

    const second = importArchive(store, archive);
    assert.equal(second.imported, 0);
    assert.equal(second.skipped, 1);
    assert.equal(second.episodesImported, 0);
    assert.equal(second.episodesSkipped, 1);
  });
});

test("round trip restores both memories and episodes, with original ids and createdAt", () => {
  withStore((source) => {
    const { memory: first, episodeId: firstEpisodeId } = source.remember({ content: "first fact" });
    waitForNextMs();
    const { memory: second, episodeId: secondEpisodeId } = source.remember({ content: "second fact" });

    const sourceEpisodes = source.episodes().items;
    assert.equal(sourceEpisodes.length, 2);

    const { archive } = exportArchive(source);

    withStore((dest) => {
      const result = importArchive(dest, archive);
      assert.equal(result.imported, 2);
      assert.equal(result.skipped, 0);
      assert.equal(result.episodesImported, 2);
      assert.equal(result.episodesSkipped, 0);
      assert.equal(result.episodes, 2);

      const destEpisodes = dest.episodes().items;
      assert.equal(destEpisodes.length, 2);
      for (const original of sourceEpisodes) {
        const imported = dest.episode(original.id);
        assert.ok(imported, `episode ${original.id} was not imported`);
        assert.equal(imported.id, original.id);
        assert.equal(imported.createdAt, original.createdAt);
        assert.equal(imported.content, original.content);
        assert.equal(imported.scope, original.scope);
        assert.equal(imported.sourceClient, original.sourceClient);
        assert.deepEqual(imported.metadata, original.metadata);
      }

      // A memory's episodeId must still resolve to a real episode in the
      // destination store, not merely to a value carried over from the
      // source -- episodes import first (FK order) precisely so this holds.
      for (const [memory, episodeId] of [
        [first, firstEpisodeId],
        [second, secondEpisodeId],
      ] as const) {
        const importedMemory = dest.get(memory.id);
        assert.ok(importedMemory);
        assert.equal(importedMemory?.episodeId, episodeId);
        assert.ok(dest.episode(episodeId), `memory ${memory.id}'s episodeId does not resolve in the destination store`);
      }
    });
  });
});

test("tags, scope, importance and sourceClient survive a round trip", () => {
  withStore((source) => {
    source.remember(
      { content: "tagged fact", tags: ["b", "a"], scope: "work", importance: 0.9 },
      { sourceClient: "claude" },
    );
    const { archive } = exportArchive(source, { scope: "work" });

    withStore((dest) => {
      importArchive(dest, archive);
      const { items } = dest.list({ scope: "work" });
      assert.equal(items.length, 1);
      const item = items[0]!;
      assert.deepEqual(item.tags, ["a", "b"]);
      assert.equal(item.scope, "work");
      assert.equal(item.importance, 0.9);
      assert.equal(item.sourceClient, "claude");
    });
  });
});

test("a tampered archive is refused and leaves the target store completely unchanged", () => {
  withStore((source) => {
    source.remember({ content: "untouched by tampering" });
    const { archive } = exportArchive(source);
    const tampered = tamperEntry(archive, "memories.jsonl");

    withStore((dest) => {
      const before = countAllMemories(dest);
      assert.throws(() => importArchive(dest, tampered), ArchiveFormatError);
      assert.equal(countAllMemories(dest), before);
    });
  });
});

test("an archive with an unknown format version is refused", () => {
  withStore((source) => {
    source.remember({ content: "versioned" });
    const { archive } = exportArchive(source);
    const entries = readZip(archive);
    const manifest = JSON.parse(entries.find((e) => e.name === "manifest.json")!.data.toString("utf8"));
    manifest.formatVersion = 999;
    const bumped = writeZip(
      entries.map((e) =>
        e.name === "manifest.json" ? { name: e.name, data: Buffer.from(JSON.stringify(manifest), "utf8") } : e,
      ),
    );

    withStore((dest) => {
      assert.throws(() => importArchive(dest, bumped), ArchiveFormatError);
    });
  });
});

test("export honours scope and the include-deleted/superseded flags", () => {
  withStore((store) => {
    store.remember({ content: "scope a fact", scope: "a" });
    store.remember({ content: "scope b fact", scope: "b" });
    const toDelete = store.remember({ content: "will be deleted", scope: "a" }).memory;
    store.forget(toDelete.id);

    const scopedOnly = exportArchive(store, { scope: "a" });
    assert.equal(scopedOnly.memories, 1); // deleted excluded by default

    const scopedWithDeleted = exportArchive(store, { scope: "a", includeDeleted: true });
    assert.equal(scopedWithDeleted.memories, 2);

    const everything = exportArchive(store, { includeDeleted: true });
    assert.equal(everything.memories, 3);
  });
});

test("the archive is a real ZIP file", () => {
  withStore((store) => {
    store.remember({ content: "a real zip" });
    const { archive } = exportArchive(store);

    const entries = readZip(archive);
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ["README.txt", "episodes.jsonl", "manifest.json", "memories.jsonl"]);

    if (!HAVE_UNZIP) {
      return;
    }
    withTempDir((dir) => {
      const path = join(dir, "export.zip");
      writeFileSync(path, archive);
      // Throws (and this test fails) if `unzip -t` reports any error.
      execFileSync("unzip", ["-t", path], { stdio: "pipe" });
    });
  });
});

test("imported memories are findable by search afterwards", async () => {
  const archive = withStore((source) => {
    source.remember({ content: "the quick brown fox jumps over the lazy dog" });
    return exportArchive(source).archive;
  });

  await withStoreAsync(async (dest) => {
    importArchive(dest, archive);
    const result = await dest.recall("quick brown fox");
    assert.ok(result.hits.some((h) => h.text.includes("quick brown fox")));
  });
});
