import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { makeTempDir, tempDbPath } from "../testing/tmp.js";
import { openDb } from "../storage/db.js";
import type { CairnDb } from "../storage/db.js";
import { createMemory, importMemory, setMemoryApproved, softDeleteMemory } from "../storage/repositories/memories.js";
import { uuidv7 } from "../util/id.js";
import { ensureVectorSpace, knn } from "../storage/repositories/vectors.js";
import type { VectorSpaceRef } from "../storage/repositories/vectors.js";
import { createFakeProvider } from "../embeddings/fake.js";
import { assertEmbeddingShape, normalize } from "../embeddings/types.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { createIndexer } from "../embeddings/worker.js";
import { search } from "./search.js";
import { ftsSearch } from "./fts.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// withTempDir's cleanup runs synchronously right after its callback returns,
// which would race an async callback's awaited work (same issue documented
// in worker.test.ts / memories.test.ts). Manage the temp dir manually.
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
      // best-effort cleanup
    }
  }
}

function ageMemory(db: CairnDb, id: string, createdAt: number): void {
  db.q("UPDATE memories SET created_at = ? WHERE id = ?").run(createdAt, id);
}

// A hand-rolled EmbeddingProvider that returns an exact, caller-chosen
// vector per input text, instead of createFakeProvider's content-hash
// vector (which is deliberately non-semantic and therefore cannot be
// steered to make one specific memory the nearest neighbour of a query).
// Used only by the two "hybrid beats a single branch" tests below, where
// the whole point is to control vector distance directly.
function createControlledProvider(vectors: Map<string, Float32Array>, dim: number): EmbeddingProvider {
  return {
    modelId: "controlled-test-model",
    dim,
    name: "fake",
    requiresNetwork: false,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out = texts.map((text) => {
        const v = vectors.get(text);
        if (!v) throw new Error(`controlled provider: no vector configured for text ${JSON.stringify(text)}`);
        return v;
      });
      assertEmbeddingShape(out, texts, dim, "fake");
      return out;
    },
    async close(): Promise<void> {},
  };
}

function vec(...values: number[]): Float32Array {
  return normalize(new Float32Array(values));
}

// Simulates a provider that resolves successfully but hands back no vector
// for the query at all (e.g. a hosted gateway returning `{"embeddings":
// []}` on a quota error) -- deliberately bypasses assertEmbeddingShape,
// which every real provider implementation is required to call.
function createEmptyVectorProvider(dim: number): EmbeddingProvider {
  return {
    modelId: "empty-vector-test-model",
    dim,
    name: "fake",
    requiresNetwork: false,
    async embed(): Promise<Float32Array[]> {
      return [];
    },
    async close(): Promise<void> {},
  };
}

interface CorpusItem {
  text: string;
  scope: string;
  tags: string[];
  importance: number;
  daysAgo: number;
}

// 22 memories: 3 scopes, 5 topics, varied tags/importance/ages. Explicit
// (not formulaic) so each filter test below can name its exact expected
// membership instead of re-deriving it from modular arithmetic.
const CORPUS: CorpusItem[] = [
  { text: "memory about the alpha project, item 1", scope: "default", tags: [], importance: 0.5, daysAgo: 0 },
  { text: "memory about the alpha project, item 2", scope: "work", tags: ["a"], importance: 0.5, daysAgo: 5 },
  { text: "memory about the alpha project, item 3", scope: "work", tags: ["a", "b"], importance: 0.6, daysAgo: 10 },
  { text: "memory about the alpha project, item 4", scope: "personal", tags: ["b"], importance: 0.4, daysAgo: 15 },
  { text: "memory about the beta project, item 5", scope: "default", tags: ["a"], importance: 0.3, daysAgo: 20 },
  { text: "memory about the beta project, item 6", scope: "work", tags: [], importance: 0.7, daysAgo: 2 },
  { text: "memory about the beta project, item 7", scope: "personal", tags: ["a", "c"], importance: 0.5, daysAgo: 8 },
  { text: "memory about the beta project, item 8", scope: "work", tags: ["b"], importance: 0.2, daysAgo: 30 },
  { text: "memory about the gamma project, item 9", scope: "default", tags: ["c"], importance: 0.9, daysAgo: 1 },
  { text: "memory about the gamma project, item 10", scope: "work", tags: ["a"], importance: 0.5, daysAgo: 40 },
  { text: "memory about the gamma project, item 11", scope: "personal", tags: [], importance: 0.5, daysAgo: 3 },
  { text: "memory about the gamma project, item 12", scope: "default", tags: ["a", "b", "c"], importance: 0.6, daysAgo: 25 },
  { text: "memory about the delta project, item 13", scope: "work", tags: ["b"], importance: 0.5, daysAgo: 12 },
  { text: "memory about the delta project, item 14", scope: "default", tags: [], importance: 0.4, daysAgo: 6 },
  { text: "memory about the delta project, item 15", scope: "personal", tags: ["a"], importance: 0.8, daysAgo: 18 },
  { text: "memory about the delta project, item 16", scope: "work", tags: ["c"], importance: 0.3, daysAgo: 45 },
  { text: "memory about the epsilon project, item 17", scope: "default", tags: ["a"], importance: 0.5, daysAgo: 9 },
  { text: "memory about the epsilon project, item 18", scope: "work", tags: [], importance: 0.6, daysAgo: 22 },
  { text: "memory about the epsilon project, item 19", scope: "personal", tags: ["b"], importance: 0.5, daysAgo: 11 },
  { text: "memory about the epsilon project, item 20", scope: "default", tags: ["a", "c"], importance: 0.7, daysAgo: 33 },
  { text: "memory about the alpha project, item 21", scope: "personal", tags: ["a"], importance: 0.5, daysAgo: 4 },
  { text: "memory about the gamma project, item 22", scope: "work", tags: ["b", "c"], importance: 0.4, daysAgo: 27 },
];

// Creates the corpus and drains a real (hash-based) fake-provider indexer
// over it, so every memory has a real vector row -- per the spec's
// instruction to use createFakeProvider + createIndexer to produce real
// vectors, not a mocked search().
async function buildCorpus(
  db: CairnDb,
): Promise<{ ids: string[]; provider: ReturnType<typeof createFakeProvider>; space: VectorSpaceRef }> {
  const now = Date.now();
  const ids: string[] = [];
  db.tx(() => {
    for (const item of CORPUS) {
      const memory = createMemory(db, { text: item.text, scope: item.scope, tags: item.tags, importance: item.importance }).memory;
      ageMemory(db, memory.id, now - item.daysAgo * DAY_MS);
      ids.push(memory.id);
    }
  });
  const provider = createFakeProvider();
  const indexer = createIndexer(db, provider);
  await indexer.drain();
  return { ids, provider, space: indexer.space };
}

test("search: hybrid surfaces a memory the vector branch finds but FTS never returns", async () => {
  await withDbAsync(async (db) => {
    const dim = 4;
    const query = "database backup schedule";
    const target = createMemory(db, { text: "the archive rotation happens every night without fail" }).memory;
    const decoyA = createMemory(db, { text: "database backup schedule for the primary server" }).memory;
    const decoyB = createMemory(db, { text: "weekly database backup schedule review meeting" }).memory;

    const vectors = new Map<string, Float32Array>([
      [query, vec(1, 0, 0, 0)],
      [target.text, vec(0.99, 0.01, 0, 0)], // deliberately near the query vector
      [decoyA.text, vec(0, 1, 0, 0)], // orthogonal: far from the query vector
      [decoyB.text, vec(0, 0, 1, 0)], // orthogonal: far from the query vector
    ]);
    const provider = createControlledProvider(vectors, dim);
    const space = ensureVectorSpace(db, provider.modelId, dim);
    const indexer = createIndexer(db, provider);
    await indexer.drain();

    // Sanity: FTS genuinely never returns the target for this query -- it
    // shares no tokens with it at all.
    const ftsOnly = await search(db, query, {}, {});
    assert.equal(ftsOnly.hits.some((h) => h.id === target.id), false);

    const hybrid = await search(db, query, {}, { provider, space });
    assert.ok(hybrid.hits.some((h) => h.id === target.id), "hybrid must surface the vector-only match");
  });
});

test("search: hybrid surfaces a memory FTS finds even when the vector branch ranks it far away", async () => {
  await withDbAsync(async (db) => {
    const dim = 4;
    const query = "quokka lighthouse festival";
    const target = createMemory(db, { text: "quokka lighthouse festival schedule announced today" }).memory;
    const decoyA = createMemory(db, { text: "an entirely unrelated note about breakfast cereal" }).memory;
    const decoyB = createMemory(db, { text: "an entirely unrelated note about traffic patterns" }).memory;

    const vectors = new Map<string, Float32Array>([
      [query, vec(1, 0, 0, 0)],
      [target.text, vec(0, 1, 0, 0)], // orthogonal: far from the query vector
      [decoyA.text, vec(0.99, 0.01, 0, 0)], // near the query vector
      [decoyB.text, vec(0.98, 0.02, 0.02, 0)], // near the query vector
    ]);
    const provider = createControlledProvider(vectors, dim);
    const space = ensureVectorSpace(db, provider.modelId, dim);
    const indexer = createIndexer(db, provider);
    await indexer.drain();

    // Sanity: vector-alone ranks the target behind both decoys.
    const [queryVector] = await provider.embed([query]);
    const knnHits = knn(db, space, queryVector!, { k: 10 });
    const targetRank = knnHits.findIndex((h) => h.memorySeq === target.seq);
    assert.ok(targetRank > 0, "target must not be the top vector-only hit");

    const hybrid = await search(db, query, {}, { provider, space });
    assert.ok(hybrid.hits.some((h) => h.id === target.id), "hybrid must still surface the FTS match");
  });
});

test("search: FTS-only mode (no provider) is not degraded; a rejecting provider is", async () => {
  await withDbAsync(async (db) => {
    createMemory(db, { text: "a plain fact findable by keyword search alone" });

    const ftsOnly = await search(db, "plain fact keyword", {}, {});
    assert.equal(ftsOnly.degraded, false);
    assert.equal(ftsOnly.degradedReason, null);
    assert.ok(ftsOnly.hits.length > 0);

    const space = ensureVectorSpace(db, "rejecting-model", 8);
    const rejecting = createFakeProvider({ modelId: "rejecting-model", dim: 8, failOn: () => true });
    const degradedResult = await search(db, "plain fact keyword", {}, { provider: rejecting, space });
    assert.equal(degradedResult.degraded, true);
    assert.ok(typeof degradedResult.degradedReason === "string" && degradedResult.degradedReason.length > 0);
    assert.ok(degradedResult.hits.length > 0, "FTS branch must still return results");
  });
});

test("search: a memory soft-deleted after indexing never surfaces, though its vector row still exists", async () => {
  await withDbAsync(async (db) => {
    const memory = createMemory(db, { text: "unique deletable secret marmoset trivia" }).memory;
    const provider = createFakeProvider();
    const indexer = createIndexer(db, provider);
    await indexer.drain();
    const space = indexer.space;

    softDeleteMemory(db, memory.id);

    const result = await search(db, "marmoset trivia", {}, { provider, space });
    assert.equal(result.hits.some((h) => h.id === memory.id), false);

    // The vector row itself was never cleaned up by search() -- confirms
    // this is genuinely a memories_live filter, not an accidental delete.
    const raw = db.q(`SELECT count(*) as c FROM ${space.tableName} WHERE memory_seq = ?`).get(memory.seq);
    assert.equal(raw?.["c"], 1);
  });
});

test("search: a memory written but not yet embedded is still findable and not dropped by MMR", async () => {
  await withDbAsync(async (db) => {
    const provider = createFakeProvider();
    const indexer = createIndexer(db, provider);
    createMemory(db, { text: "already indexed filler about weather" });
    await indexer.drain();

    const fresh = createMemory(db, { text: "brand new unindexed fact about penguins" }).memory;

    const result = await search(db, "unindexed fact penguins", {}, { provider, space: indexer.space });
    assert.ok(result.hits.some((h) => h.id === fresh.id));
  });
});

test("search: scope and tags filters apply to results sourced purely from the vector branch", async () => {
  await withDbAsync(async (db) => {
    const dim = 4;
    const kept = createMemory(db, { text: "kept memory content", scope: "work", tags: ["keepme"] }).memory;
    const dropped = createMemory(db, { text: "dropped memory content", scope: "personal", tags: [] }).memory;

    const vectors = new Map<string, Float32Array>([
      ["???", vec(1, 0, 0, 0)],
      [kept.text, vec(0.9, 0.1, 0, 0)],
      [dropped.text, vec(0.8, 0.2, 0, 0)],
    ]);
    const provider = createControlledProvider(vectors, dim);
    const space = ensureVectorSpace(db, provider.modelId, dim);
    const indexer = createIndexer(db, provider);
    await indexer.drain();

    // "???" tokenizes to nothing (see fts.ts's toMatchQuery), so every hit
    // below is sourced entirely by the vector branch.
    const scoped = await search(db, "???", { scope: "work" }, { provider, space });
    assert.deepEqual(scoped.hits.map((h) => h.id).sort(), [kept.id]);

    const tagged = await search(db, "???", { tags: ["keepme"] }, { provider, space });
    assert.deepEqual(tagged.hits.map((h) => h.id).sort(), [kept.id]);
  });
});

test("search: minCoverage exempts vector-branch-only hits, even at the maximum floor", async () => {
  await withDbAsync(async (db) => {
    const dim = 4;
    const query = "database backup schedule";
    // Shares zero words with the query -- FTS never returns it, so it can
    // only appear here via the vector branch, which has no term-coverage
    // signal by nature (see SearchOptions.minCoverage).
    const target = createMemory(db, { text: "the archive rotation happens every night without fail" }).memory;

    const vectors = new Map<string, Float32Array>([
      [query, vec(1, 0, 0, 0)],
      [target.text, vec(0.99, 0.01, 0, 0)],
    ]);
    const provider = createControlledProvider(vectors, dim);
    const space = ensureVectorSpace(db, provider.modelId, dim);
    const indexer = createIndexer(db, provider);
    await indexer.drain();

    const result = await search(db, query, { minCoverage: 1 }, { provider, space });
    assert.ok(
      result.hits.some((h) => h.id === target.id),
      "a vector-only hit must survive even minCoverage's maximum (1.0) setting",
    );
    const hit = result.hits.find((h) => h.id === target.id);
    assert.equal(hit?.coverage, null, "a vector-only hit carries no FTS coverage signal");
  });
});

test("search: minCoverage filters a weak FTS-branch match while a fully-covering one survives", async () => {
  await withDbAsync(async (db) => {
    const strong = createMemory(db, { text: "kubernetes deployment rollback procedure documented here" }).memory;
    const weak = createMemory(db, { text: "the garden deployment of new roses went well" }).memory;

    const permissive = await search(db, "kubernetes deployment rollback procedure", { minCoverage: 0 }, {});
    assert.ok(permissive.hits.some((h) => h.id === strong.id));
    assert.ok(permissive.hits.some((h) => h.id === weak.id), "a loose, one-term-of-four match survives a floor of 0");

    const strict = await search(db, "kubernetes deployment rollback procedure", { minCoverage: 0.5 }, {});
    assert.ok(strict.hits.some((h) => h.id === strong.id), "a full-coverage match must survive");
    assert.equal(
      strict.hits.some((h) => h.id === weak.id),
      false,
      "a one-term-of-four (0.25) match must not survive a 0.5 floor",
    );
  });
});

test("search: a single-content-word query is never narrowed by the coverage floor, even at its maximum", async () => {
  await withDbAsync(async (db) => {
    const memory = createMemory(db, { text: "a note that mentions xenon once" }).memory;
    const result = await search(db, "xenon", { minCoverage: 1 }, {});
    assert.ok(result.hits.some((h) => h.id === memory.id));
  });
});

test("search: scope and tags filters apply on a mixed hybrid corpus", async () => {
  await withDbAsync(async (db) => {
    const { provider, space } = await buildCorpus(db);

    // Only the scope filter (a structural constraint applied to both
    // branches) is asserted here, not topical relevance: the fake provider
    // is a non-semantic content hash, so its vector branch can legitimately
    // pull in a same-scope memory that shares no words with the query --
    // that is not a filter bug, it is exactly what an unrelated-but-scoped
    // vector neighbour looks like.
    const alphaWork = await search(db, "alpha", { scope: "work", limit: 20 }, { provider, space });
    assert.ok(alphaWork.hits.length > 0);
    assert.ok(alphaWork.hits.every((h) => h.scope === "work"));

    const alphaTagA = await search(db, "alpha", { tags: ["a"], limit: 20 }, { provider, space });
    assert.ok(alphaTagA.hits.length > 0);
    assert.ok(alphaTagA.hits.every((h) => h.tags.includes("a")));
  });
});

test("search: limit clamps to 50 and defaults to 10; candidateLimit clamps to 200", async () => {
  await withDbAsync(async (db) => {
    db.tx(() => {
      for (let i = 0; i < 60; i++) {
        createMemory(db, { text: `bulk clamp searchable memory number ${i}` });
      }
    });

    const defaulted = await search(db, "bulk clamp searchable memory", {}, {});
    assert.equal(defaulted.hits.length, 10);

    const clamped = await search(db, "bulk clamp searchable memory", { limit: 99999, candidateLimit: 99999 }, {});
    assert.equal(clamped.hits.length, 50);
  });
});

test("search: same query twice returns identical ordering (determinism)", async () => {
  await withDbAsync(async (db) => {
    const { provider, space } = await buildCorpus(db);
    const now = Date.now();
    const first = await search(db, "project", { limit: 15, now }, { provider, space });
    const second = await search(db, "project", { limit: 15, now }, { provider, space });
    assert.deepEqual(
      first.hits.map((h) => h.id),
      second.hits.map((h) => h.id),
    );
  });
});

test("search: `now` is honoured -- the same pair ranks differently at two different now values", async () => {
  await withDbAsync(async (db) => {
    const setupNow = Date.now();
    const recentLowImportance = createMemory(db, { text: "chronotest entry alpha details recorded", importance: 0.1 }).memory;
    ageMemory(db, recentLowImportance.id, setupNow);
    const oldHighImportance = createMemory(db, { text: "chronotest entry beta details recorded", importance: 0.9 }).memory;
    ageMemory(db, oldHighImportance.id, setupNow - 60 * DAY_MS);

    // weights.relevance: 0 isolates recency+importance from any BM25 rank
    // tie-break noise between the two near-identical documents above.
    const soon = await search(db, "chronotest", { weights: { relevance: 0 }, now: setupNow }, {});
    assert.equal(soon.hits[0]?.id, recentLowImportance.id);

    const muchLater = await search(
      db,
      "chronotest",
      { weights: { relevance: 0 }, now: setupNow + 400 * DAY_MS },
      {},
    );
    assert.equal(muchLater.hits[0]?.id, oldHighImportance.id);
  });
});

// BUILD_BRIEF §14's "context pollution" failure, reproduced against the
// full pipeline: a query with no real subject in common with the store must
// not return confident-looking hits built entirely on function words like
// "the"/"is"/"a". Fails without the fix (toMatchQuery ORs every raw token,
// including stopwords, so "the"/"is" alone matches most of the corpus).
test("search: an off-topic query against a topically-unrelated corpus returns zero hits (BUILD_BRIEF §14 context-pollution regression)", async () => {
  await withDbAsync(async (db) => {
    const dogMemory = createMemory(db, { text: "the dog loves to play fetch in the park every morning" }).memory;
    createMemory(db, { text: "fresh bread from the bakery smells wonderful in the morning" });
    createMemory(db, { text: "the garden needs watering twice a week in the summer" });
    createMemory(db, { text: "the cat sleeps on the windowsill in the afternoon sun" });
    createMemory(db, { text: "tomato soup pairs well with a grilled cheese sandwich" });

    const offTopic = await search(db, "what is the kubernetes deployment rollback procedure", {}, {});
    assert.deepEqual(offTopic.hits, []);
    assert.equal(offTopic.degraded, false);

    const onTopic = await search(db, "what does the dog like to do", {}, {});
    assert.ok(onTopic.hits.some((h) => h.id === dogMemory.id));
  });
});

// Reviewer-reported regression: the vector branch used to filter tags AFTER
// knn's fan-out, so a tagged memory ranked below candidateLimit by raw
// vector distance was cut before the tag filter ever saw it -- `recall`
// could report "no memories" for a tag the dashboard shows. Fails without
// the fix (the sanity check below documents exactly why).
test("search: a tag-filtered vector-only match is never starved by the branch's candidate fan-out", async () => {
  await withDbAsync(async (db) => {
    const dim = 4;
    const query = "???"; // tokenizes to nothing -- every hit below is vector-sourced only
    const candidateLimit = 5;

    const vectors = new Map<string, Float32Array>([[query, vec(1, 0, 0, 0)]]);
    for (let i = 0; i < 10; i++) {
      const memory = createMemory(db, { text: `untagged filler memory number ${i}` }).memory;
      vectors.set(memory.text, vec(1, 0.001 * (i + 1), 0, 0)); // close to the query -- outranks every tagged memory below
    }
    const taggedMemories: { id: string; seq: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const memory = createMemory(db, { text: `ops tagged memory number ${i}`, tags: ["ops"] }).memory;
      taggedMemories.push({ id: memory.id, seq: memory.seq });
      // Far enough to rank behind every filler memory (which sit almost
      // exactly on the query vector) and outside the naive candidateLimit
      // fan-out, but still within DEFAULT_MAX_VECTOR_DISTANCE (~0.85 cosine
      // similarity here) -- this test is about the fan-out starvation fix,
      // not the absolute vector-distance floor (see the maxVectorDistance
      // tests below), so a fully orthogonal vector would be filtered by
      // BOTH mechanisms and no longer isolate the one under test here.
      vectors.set(memory.text, vec(0.85, 0.527, 0, 0));
    }

    const provider = createControlledProvider(vectors, dim);
    const space = ensureVectorSpace(db, provider.modelId, dim);
    const indexer = createIndexer(db, provider);
    await indexer.drain();

    // Sanity: the naive knn(candidateLimit)-then-filter approach really
    // would starve every tagged memory here -- none rank within the top
    // candidateLimit vector neighbours.
    const [queryVector] = await provider.embed([query]);
    const knnRanks = knn(db, space, queryVector!, { k: candidateLimit }).map((h) => h.memorySeq);
    for (const tagged of taggedMemories) {
      assert.equal(
        knnRanks.includes(tagged.seq),
        false,
        "sanity: tagged memory must rank outside the naive candidateLimit fan-out",
      );
    }

    const result = await search(db, query, { tags: ["ops"], limit: 10, candidateLimit }, { provider, space });
    assert.equal(result.degraded, false);
    assert.deepEqual(
      result.hits.map((h) => h.id).sort(),
      taggedMemories.map((m) => m.id).sort(),
    );
  });
});

test("search: a provider that resolves with no vector for the query degrades explicitly, not silently", async () => {
  await withDbAsync(async (db) => {
    createMemory(db, { text: "a plain fact findable by keyword search alone" });
    const dim = 4;
    const space = ensureVectorSpace(db, "empty-vector-test-model", dim);
    const provider = createEmptyVectorProvider(dim);

    const result = await search(db, "plain fact keyword", {}, { provider, space });
    assert.equal(result.degraded, true);
    assert.ok(typeof result.degradedReason === "string" && result.degradedReason.length > 0);
    assert.ok(result.hits.length > 0, "FTS branch must still return results");
  });
});

// Proves fusion, not just union coverage: the "hybrid beats either branch"
// tests above would still pass if search() concatenated the branches and
// skipped rrfFuse entirely. This pins the property the whole design rests
// on (rrf.test.ts pins it at the rrfFuse unit level; nothing else pins it
// through the full pipeline): a memory ranked in BOTH branches must outrank
// one ranked #1 in only ONE branch, because RRF sums reciprocal ranks
// across lists.
test("search: fusion beats either branch alone -- a memory ranked in both branches outranks one ranked #1 in a single branch", async () => {
  await withDbAsync(async (db) => {
    const dim = 4;
    const query = "beacon signal";
    const candidateLimit = 4;

    const decoyFtsTop = createMemory(db, { text: "beacon signal beacon signal" }).memory;
    const target = createMemory(db, { text: "beacon signal notice" }).memory;
    const fillerA = createMemory(db, { text: "beacon signal update" }).memory;
    const fillerB = createMemory(db, { text: "beacon only mention here" }).memory;
    const fillerC = createMemory(db, { text: "signal only mention here" }).memory;

    const vectors = new Map<string, Float32Array>([
      [query, vec(1, 0, 0, 0)],
      [target.text, vec(0.95, 0.05, 0, 0)], // nearest to the query
      [fillerA.text, vec(0.9, 0.1, 0, 0)], // second nearest
      [fillerB.text, vec(0.1, 0.9, 0, 0)], // third nearest
      [fillerC.text, vec(0.05, 0, 0.95, 0)], // fourth nearest
      [decoyFtsTop.text, vec(0, 0, 0, 1)], // orthogonal -- excluded once k is capped at candidateLimit
    ]);
    const provider = createControlledProvider(vectors, dim);
    const space = ensureVectorSpace(db, provider.modelId, dim);
    const indexer = createIndexer(db, provider);
    await indexer.drain();

    // Confirm the corpus actually has the shape this property test needs,
    // rather than assuming bm25/knn's exact ordering.
    const ftsRanks = ftsSearch(db, query, { limit: candidateLimit }).map((h) => h.id);
    assert.equal(ftsRanks[0], decoyFtsTop.id, "decoy must be the sole rank-1 FTS match");
    const targetFtsRank = ftsRanks.indexOf(target.id);
    assert.ok(targetFtsRank > 0 && targetFtsRank < candidateLimit, "target must rank behind the decoy but still within the FTS candidate window");

    const [queryVector] = await provider.embed([query]);
    const knnRanks = knn(db, space, queryVector!, { k: candidateLimit }).map((h) => h.memorySeq);
    assert.ok(knnRanks.includes(target.seq), "target must be within the vector candidate window");
    assert.equal(knnRanks.includes(decoyFtsTop.seq), false, "decoy must be absent from the vector branch entirely");

    const result = await search(db, query, { candidateLimit, limit: 10 }, { provider, space });
    const targetIndex = result.hits.findIndex((h) => h.id === target.id);
    const decoyIndex = result.hits.findIndex((h) => h.id === decoyFtsTop.id);
    assert.ok(targetIndex >= 0 && decoyIndex >= 0, "both must appear in the fused, hybrid result");
    assert.ok(targetIndex < decoyIndex, "a memory ranked in both branches must outrank one ranked #1 in a single branch");
  });
});

// The old test only pinned the OUTPUT `limit` clamp (clampSearchLimit):
// `limit: 99999, candidateLimit: 99999` still yields exactly 50 hits even
// if candidateLimit's OWN clamp is deleted entirely, because ftsSearch/knn
// each already cap their own fan-out at 200/200 independently -- the test
// stayed green with zero coverage of clampCandidateLimit. This pins
// candidateLimit's actual effect on per-branch fan-out instead.
test("search: candidateLimit actually controls per-branch fan-out, not just the final page", async () => {
  await withDbAsync(async (db) => {
    const dim = 4;
    const query = "candidate limit fan-out probe";
    const target = createMemory(db, { text: "an entirely different note with nothing in common lexically" }).memory;

    const vectors = new Map<string, Float32Array>([
      [query, vec(1, 0, 0, 0)],
      [target.text, vec(0.9, 0.05, 0.05, 0)],
    ]);
    // 30 decoys, all strictly closer to the query than `target`, pushing it
    // to vector rank 31 -- beyond knn's own default k (10), but within
    // search()'s own default candidateLimit (50).
    for (let i = 0; i < 30; i++) {
      const decoy = createMemory(db, { text: `unrelated decoy filler number ${i}` }).memory;
      vectors.set(decoy.text, vec(1, 0.0001 * (i + 1), 0, 0));
    }
    const provider = createControlledProvider(vectors, dim);
    const space = ensureVectorSpace(db, provider.modelId, dim);
    const indexer = createIndexer(db, provider);
    await indexer.drain();

    const [queryVector] = await provider.embed([query]);
    const targetRank = knn(db, space, queryVector!, { k: 50 }).findIndex((h) => h.memorySeq === target.seq) + 1;
    assert.ok(targetRank > 10 && targetRank <= 50, `expected target rank in (10, 50], got ${targetRank}`);

    // Explicit candidateLimit smaller than target's true rank: excluded.
    const tooNarrow = await search(db, query, { candidateLimit: 5, limit: 50 }, { provider, space });
    assert.equal(tooNarrow.hits.some((h) => h.id === target.id), false);

    // No candidateLimit given: search()'s OWN default (50) must be
    // substituted -- not left undefined for knn's much smaller default (10)
    // to kick in, which is exactly what breaks if clampCandidateLimit's
    // default-substitution branch is removed.
    const defaulted = await search(db, query, { limit: 50 }, { provider, space });
    assert.ok(defaulted.hits.some((h) => h.id === target.id));
  });
});

// CRITICAL 3 regression (audit reproduction): relevance used to be
// normalised only against THIS call's own top fused score
// (`score / maxScore`), which in a single-branch (FTS-only, the default)
// result set compresses the WHOLE relevance spread into a curve that only
// reaches ~0.55 by rank 10 -- less dynamic range than the recency term's
// own span. That let a several-ranks-worse, half-covering, less important,
// merely-fresher chaff memory outscore a fully-covering, more important,
// slightly-older correct answer on the blended score. Fails without the
// fix: `chaff` ranks ahead of `correct`.
test("search: relevance keeps a real dynamic range across the top of a single-branch result set (BUILD_BRIEF §7 relevance-vs-recency regression)", async () => {
  await withDbAsync(async (db) => {
    const now = Date.now();
    const correct = createMemory(db, {
      text: "the kubernetes deployment rollback procedure is documented here for reference",
      importance: 1.0,
    }).memory;
    ageMemory(db, correct.id, now - 7 * DAY_MS);

    const chaff = createMemory(db, {
      text: "deployment rollback deployment rollback quick fix deployment rollback",
      importance: 0.5,
    }).memory;
    ageMemory(db, chaff.id, now);

    // Distractors purely to give the fused list enough spread for the
    // dynamic-range defect to bite -- see the module-level regression note
    // above (a two-candidate list alone would already show the effect, but
    // this is closer to the audit's reproduction, which used a 20-memory
    // corpus).
    const fillerTerms = ["kubernetes", "rollback", "procedure"];
    for (let i = 0; i < 8; i++) {
      const t = fillerTerms[i % fillerTerms.length];
      const filler = createMemory(db, { text: `${t} ${t} ${t} ${t} filler note number ${i}` }).memory;
      ageMemory(db, filler.id, now - 20 * DAY_MS);
    }

    const result = await search(db, "kubernetes deployment rollback procedure", {}, {});
    const correctIndex = result.hits.findIndex((h) => h.id === correct.id);
    const chaffIndex = result.hits.findIndex((h) => h.id === chaff.id);
    assert.ok(correctIndex >= 0 && chaffIndex >= 0, "both must appear in the result");
    assert.ok(
      correctIndex < chaffIndex,
      "the fully-covering, more important, only-slightly-older correct answer must outrank the fresher-but-worse chaff",
    );
  });
});

// CRITICAL 4 regression (audit reproduction): the vector branch had no
// absolute distance floor, so KNN's k nearest neighbours entered fusion
// however far away they actually were -- a store with no memory genuinely
// related to the query still returned its k nearest (however distant)
// neighbours, sometimes ranked at the very top. Fails without the fix: all
// eight topically-unrelated (pet-themed) memories are returned for a
// kubernetes query, undegraded.
test("search: the vector branch has an absolute distance floor -- unrelated memories are not returned just for being the nearest available (BUILD_BRIEF §14 semantic-mode context-pollution regression)", async () => {
  await withDbAsync(async (db) => {
    const dim = 4;
    const query = "kubernetes deployment rollback procedure";
    const petTexts = [
      "the cat needs a vet checkup next week",
      "remember to buy more dog food this weekend",
      "the parrot learned a new word today",
      "fish tank filter needs cleaning",
      "the hamster wheel is squeaking again",
      "the rabbit hutch needs fresh bedding",
      "the turtle tank water needs changing",
      "the dog groomer appointment is on friday",
    ];
    const pets = petTexts.map((text) => createMemory(db, { text }).memory);

    // Every pet memory is placed ORTHOGONAL to the query vector -- as
    // semantically unrelated as two real embeddings from the local models
    // this project ships get (see SearchOptions.maxVectorDistance's doc:
    // even genuinely unrelated real pairs still sit at ~0.6-0.75 cosine
    // similarity due to anisotropy, i.e. distance ~0.25-0.4 -- fully
    // orthogonal, distance 1.0, is at least as unrelated as that).
    const vectors = new Map<string, Float32Array>([[query, vec(1, 0, 0, 0)]]);
    for (const pet of pets) {
      vectors.set(pet.text, vec(0, 1, 0, 0));
    }
    const provider = createControlledProvider(vectors, dim);
    const space = ensureVectorSpace(db, provider.modelId, dim);
    const indexer = createIndexer(db, provider);
    await indexer.drain();

    const result = await search(db, query, {}, { provider, space });
    assert.deepEqual(result.hits, [], "an entirely unrelated store must return nothing, not its nearest-however-far neighbours");
    assert.equal(result.degraded, false, "a filtered-out vector branch is not a degradation -- see SearchOptions.maxVectorDistance");
  });
});

test("search: a vector hit within maxVectorDistance still surfaces, carrying its distance on the hit", async () => {
  await withDbAsync(async (db) => {
    const dim = 4;
    const query = "database backup schedule";
    const target = createMemory(db, { text: "the archive rotation happens every night without fail" }).memory;
    const vectors = new Map<string, Float32Array>([
      [query, vec(1, 0, 0, 0)],
      [target.text, vec(0.99, 0.01, 0, 0)],
    ]);
    const provider = createControlledProvider(vectors, dim);
    const space = ensureVectorSpace(db, provider.modelId, dim);
    const indexer = createIndexer(db, provider);
    await indexer.drain();

    const result = await search(db, query, {}, { provider, space });
    const hit = result.hits.find((h) => h.id === target.id);
    assert.ok(hit, "a genuinely close vector-only hit must survive the default floor");
    assert.ok(typeof hit!.vectorDistance === "number" && hit!.vectorDistance < 0.01);
  });
});

test("search: an explicit, permissive maxVectorDistance lets a distant vector hit back in", async () => {
  await withDbAsync(async (db) => {
    const dim = 4;
    const query = "kubernetes deployment rollback procedure";
    const pet = createMemory(db, { text: "the cat needs a vet checkup next week" }).memory;
    const vectors = new Map<string, Float32Array>([
      [query, vec(1, 0, 0, 0)],
      [pet.text, vec(0, 1, 0, 0)], // orthogonal, distance 1.0
    ]);
    const provider = createControlledProvider(vectors, dim);
    const space = ensureVectorSpace(db, provider.modelId, dim);
    const indexer = createIndexer(db, provider);
    await indexer.drain();

    const strict = await search(db, query, {}, { provider, space });
    assert.equal(strict.hits.length, 0);

    const permissive = await search(db, query, { maxVectorDistance: 1.5 }, { provider, space });
    assert.ok(permissive.hits.some((h) => h.id === pet.id));
  });
});

// BUILD_BRIEF §3: never KNN across mismatched models. A provider and a
// vector space that disagree on modelId (even at the same dim) must never
// silently run KNN against each other's vectors.
test("search: a provider/space model-id mismatch skips the vector branch and reports degraded, never running cross-model KNN", async () => {
  await withDbAsync(async (db) => {
    const dim = 4;
    createMemory(db, { text: "a plain fact findable by keyword search alone" });
    const space = ensureVectorSpace(db, "model-a", dim);
    const provider = createControlledProvider(new Map(), dim);
    Object.defineProperty(provider, "modelId", { value: "model-b", configurable: true });

    const result = await search(db, "plain fact keyword", {}, { provider, space });
    assert.equal(result.degraded, true);
    assert.ok(typeof result.degradedReason === "string" && result.degradedReason.includes("model-a"));
    assert.ok(result.hits.length > 0, "FTS branch must still return results");
  });
});

// Regression: min-max normalising relevance against BOTH ends of the fused
// set (for the rerank BLEND) also pins the single worst-fused-rank
// candidate to exactly 0 for every N -- if `minRelevance`'s default floor
// were applied against THAT scale (instead of the max-only scale in
// `preNormRelevanceById`), it would cut the worst survivor of every
// non-empty result set regardless of how good it actually is. Five
// memories that all equally match the query (same BM25 rank basis) must
// all five come back at the default floor.
test("search: five equally-matching memories all survive the default relevance floor", async () => {
  await withDbAsync(async (db) => {
    const memories = Array.from({ length: 5 }, (_, i) =>
      createMemory(db, { text: `kubernetes deployment rollback procedure number ${i}` }).memory,
    );

    const result = await search(db, "kubernetes deployment rollback procedure", {}, {});
    assert.deepEqual(
      result.hits.map((h) => h.id).sort(),
      memories.map((m) => m.id).sort(),
      "all five equally-matching memories must survive the default minRelevance floor",
    );
  });
});

// Same regression, at the sharper edge the audit measured: with only TWO
// fused candidates, min-max normalisation gives the worse-ranked one
// EXACTLY 0 relevance -- if that were the scale minRelevance's default
// floor read, it alone would cut it, no matter how good a match it
// genuinely is.
test("search: two matching memories both survive the default relevance floor", async () => {
  await withDbAsync(async (db) => {
    const a = createMemory(db, { text: "kubernetes deployment rollback procedure alpha" }).memory;
    const b = createMemory(db, { text: "kubernetes deployment rollback procedure beta" }).memory;

    const result = await search(db, "kubernetes deployment rollback procedure", {}, {});
    assert.deepEqual(
      result.hits.map((h) => h.id).sort(),
      [a.id, b.id].sort(),
      "both matching memories must survive the default minRelevance floor",
    );
  });
});

// GAP 2 (BUILD_BRIEF §10/§14): a caller labelling provenance instead of
// excluding it (src/mcp/tools.ts's get_context/recall) needs origin/
// approved ON the hit itself -- this pins that search() actually stamps
// both, for a plain 'user' write and for an imported, unapproved one.
test("search: every hit carries its own origin and approved flag", async () => {
  await withDbAsync(async (db) => {
    const user = createMemory(db, { text: "kubernetes cluster upgrade checklist" }).memory;
    const importResult = importMemory(db, { id: uuidv7(), text: "kubernetes cluster upgrade notes from an export" });
    const imported = importResult.memory!;

    const result = await search(db, "kubernetes cluster upgrade", {}, {});
    const byId = new Map(result.hits.map((h) => [h.id, h]));

    assert.equal(byId.get(user.id)?.origin, "user");
    assert.equal(byId.get(user.id)?.approved, false);
    assert.equal(byId.get(imported.id)?.origin, "import");
    assert.equal(byId.get(imported.id)?.approved, false);

    setMemoryApproved(db, imported.id, true);
    const afterApproval = await search(db, "kubernetes cluster upgrade", {}, {});
    const approvedHit = afterApproval.hits.find((h) => h.id === imported.id);
    assert.equal(approvedHit?.approved, true, "approved flag must reflect a later approval, not be cached");
  });
});
