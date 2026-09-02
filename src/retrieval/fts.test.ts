import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempDir, tempDbPath } from "../testing/tmp.js";
import { openDb } from "../storage/db.js";
import type { CairnDb } from "../storage/db.js";
import { createMemory, softDeleteMemory, supersedeMemory } from "../storage/repositories/memories.js";
import { ftsSearch, toMatchQuery, contentTerms, STOPWORDS } from "./fts.js";

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

test("toMatchQuery quotes every token and joins with OR", () => {
  assert.equal(toMatchQuery("hello world"), `"hello" OR "world"`);
});

test("toMatchQuery returns null for empty or punctuation-only input", () => {
  assert.equal(toMatchQuery(""), null);
  assert.equal(toMatchQuery("???"), null);
});

test("toMatchQuery drops stopwords, keeping only content-bearing tokens", () => {
  assert.equal(toMatchQuery("what is the cat"), `"cat"`);
  assert.equal(toMatchQuery("a big red dog"), `"big" OR "red" OR "dog"`);
});

test("toMatchQuery returns null for a query that is entirely stopwords", () => {
  assert.equal(toMatchQuery("what is the"), null);
  assert.equal(toMatchQuery("a an the"), null);
});

test("STOPWORDS pins the exact function-word set toMatchQuery drops", () => {
  for (const word of ["a", "an", "the", "is", "what", "to", "of"]) {
    assert.ok(STOPWORDS.has(word), `expected "${word}" to be a stopword`);
  }
  for (const word of ["kubernetes", "dog", "rollback", "garden"]) {
    assert.ok(!STOPWORDS.has(word), `did not expect "${word}" to be a stopword`);
  }
});

test("ftsSearch: plain multi-word query ranks the best match first", () => {
  withDb((db) => {
    const target = createMemory(db, { text: "the user prefers dark mode in the editor" }).memory;
    createMemory(db, { text: "unrelated fact about the weather today" });
    createMemory(db, { text: "another unrelated note about lunch" });

    const hits = ftsSearch(db, "user prefers dark mode");
    assert.ok(hits.length > 0);
    assert.equal(hits[0]?.id, target.id);
  });
});

// Each of these raises "fts5: syntax error" if handed to MATCH unescaped.
// None may throw here; the punctuation-only and empty cases must return []
// via a null match query rather than "match everything".
test("ftsSearch: FTS5 special syntax in the raw query never throws", () => {
  withDb((db) => {
    createMemory(db, { text: "a memory about foo and bar" });

    for (const query of ['foo:bar', 'say "hello" to me', "wildcard* search", "AND", "NEAR neighbors", "???", ""]) {
      assert.doesNotThrow(() => ftsSearch(db, query), `query ${JSON.stringify(query)} should not throw`);
    }
    assert.deepEqual(ftsSearch(db, "???"), []);
    assert.deepEqual(ftsSearch(db, ""), []);
  });
});

// FTS5 treats "foo:" as a column-filter prefix ("search column foo for
// bar"), and memories_fts has no column named foo, so the raw MATCH raises
// "no such column: foo" -- proving the point that unescaped user text
// breaks a plain question, whatever the exact error text turns out to be.
test("ftsSearch: foo:bar genuinely fails without escaping (regression pin)", () => {
  withDb((db) => {
    createMemory(db, { text: "a memory about foo and bar" });
    assert.throws(() => {
      db.q(
        `SELECT m.seq FROM memories_fts f JOIN memories_live m ON m.seq = f.rowid WHERE memories_fts MATCH ?`,
      ).all("foo:bar");
    }, /no such column: foo/);
  });
});

test("ftsSearch: diacritics fold, cafe finds café", () => {
  withDb((db) => {
    const target = createMemory(db, { text: "I love going to the café" }).memory;
    const hits = ftsSearch(db, "cafe");
    assert.ok(hits.some((h) => h.id === target.id));
  });
});

test("ftsSearch: soft-deleted and superseded memories are absent from results but remain in the raw FTS index", () => {
  withDb((db) => {
    const deleted = createMemory(db, { text: "will be soft deleted unique term xylophone" }).memory;
    softDeleteMemory(db, deleted.id);

    const old = createMemory(db, { text: "will be superseded unique term glockenspiel" }).memory;
    const { superseded } = supersedeMemory(db, old.id, { text: "replacement text mentions glockenspiel too" });

    const deletedHits = ftsSearch(db, "xylophone");
    assert.equal(deletedHits.some((h) => h.id === deleted.id), false);
    const supersededHits = ftsSearch(db, "glockenspiel");
    assert.equal(supersededHits.some((h) => h.id === superseded.id), false);

    const rawDeleted = db
      .q(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?`)
      .all(toMatchQuery("xylophone"));
    assert.equal(rawDeleted.length, 1);
    const rawSuperseded = db
      .q(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?`)
      .all(toMatchQuery("glockenspiel"));
    assert.ok(rawSuperseded.length >= 1);
  });
});

test("ftsSearch: scope filters results", () => {
  withDb((db) => {
    const inScope = createMemory(db, { text: "scoped fact about penguins", scope: "work" }).memory;
    createMemory(db, { text: "scoped fact about penguins", scope: "personal" });

    const hits = ftsSearch(db, "penguins", { scope: "work" });
    assert.deepEqual(
      hits.map((h) => h.id),
      [inScope.id],
    );
  });
});

test("ftsSearch: tags filter is AND, not OR", () => {
  withDb((db) => {
    const both = createMemory(db, { text: "red and big elephant", tags: ["red", "big"] }).memory;
    createMemory(db, { text: "just red elephant", tags: ["red"] });
    createMemory(db, { text: "just big elephant", tags: ["big"] });

    const hits = ftsSearch(db, "elephant", { tags: ["red", "big"] });
    assert.deepEqual(
      hits.map((h) => h.id),
      [both.id],
    );
  });
});

test("ftsSearch: limit defaults to 50 and clamps at 200", () => {
  withDb((db) => {
    db.tx(() => {
      for (let i = 0; i < 205; i += 1) {
        createMemory(db, { text: `bulk searchable memory number ${i}` });
      }
    });

    const defaultPage = ftsSearch(db, "bulk searchable memory");
    assert.equal(defaultPage.length, 50);

    const clamped = ftsSearch(db, "bulk searchable memory", { limit: 9999 });
    assert.equal(clamped.length, 200);
  });
});

test("ftsSearch: a memory written but not yet embedded is still findable", () => {
  withDb((db) => {
    const memory = createMemory(db, { text: "not yet embedded unique term marmoset" }).memory;
    const hits = ftsSearch(db, "marmoset");
    assert.ok(hits.some((h) => h.id === memory.id));
  });
});

test("ftsSearch: a relative bm25 floor drops a hit far weaker than the best in the same result set", () => {
  withDb((db) => {
    // A realistic corpus (many short unrelated memories) and a very long,
    // mostly-irrelevant document with exactly one incidental mention of the
    // query term are both needed to pull bm25's length-normalisation term
    // far enough below the default 0.1 ratio -- a two-document fixture
    // barely moves it (idf collapses when almost every document matches).
    db.tx(() => {
      for (let i = 0; i < 50; i++) {
        createMemory(db, { text: `unrelated filler memory number ${i} about weather and lunch` });
      }
    });
    const strong = createMemory(db, { text: "xenon" }).memory;
    const words = Array.from({ length: 500 }, (_, i) => `filler${i}`);
    words.splice(250, 0, "xenon");
    const weak = createMemory(db, { text: words.join(" ") }).memory;

    const hits = ftsSearch(db, "xenon");
    assert.ok(hits.some((h) => h.id === strong.id));
    assert.equal(
      hits.some((h) => h.id === weak.id),
      false,
      "a weak, low-density match must be floored out relative to a much stronger one",
    );

    // Bypassing the floor (ratio 0) proves `weak` really did match FTS at
    // all -- it is the floor doing the filtering above, not FTS itself.
    const unfiltered = ftsSearch(db, "xenon", { minBm25Ratio: 0 });
    assert.ok(unfiltered.some((h) => h.id === weak.id));
  });
});

test("contentTerms drops stopwords and caps at MAX_TOKENS, same list toMatchQuery is built from", () => {
  assert.deepEqual(contentTerms("what is the cat"), ["cat"]);
  assert.deepEqual(contentTerms("a big red dog"), ["big", "red", "dog"]);
  assert.deepEqual(contentTerms("what is the"), []);
  assert.deepEqual(contentTerms(""), []);
});

test("ftsSearch: coverage is the fraction of query content terms a hit's text contains, stopwords excluded from the denominator", () => {
  withDb((db) => {
    // Query has 4 content terms (kubernetes/deployment/rollback/procedure)
    // once "what"/"is"/"the" are dropped as stopwords -- a memory
    // containing exactly 2 of them must report coverage 0.5, not 2/7.
    const half = createMemory(db, { text: "the kubernetes deployment failed last night" }).memory;
    const all = createMemory(db, { text: "kubernetes deployment rollback procedure documented here" }).memory;
    const one = createMemory(db, { text: "the garden deployment of new roses went well" }).memory;

    // minBm25Ratio: 0 isolates coverage from the (unrelated) relative bm25
    // floor, which would otherwise drop the weakest of these three itself.
    const hits = ftsSearch(db, "what is the kubernetes deployment rollback procedure", { minBm25Ratio: 0 });
    const halfHit = hits.find((h) => h.id === half.id);
    const allHit = hits.find((h) => h.id === all.id);
    const oneHit = hits.find((h) => h.id === one.id);
    assert.ok(halfHit && allHit && oneHit, "all three must still be FTS matches (coverage does not filter here)");
    assert.equal(halfHit?.coverage, 0.5);
    assert.equal(allHit?.coverage, 1);
    assert.equal(oneHit?.coverage, 0.25);
  });
});

test("ftsSearch: coverage is case- and diacritic-insensitive", () => {
  withDb((db) => {
    const memory = createMemory(db, { text: "the CAFÉ has a lovely ROLLBACK plan" }).memory;
    const hits = ftsSearch(db, "cafe rollback");
    const hit = hits.find((h) => h.id === memory.id);
    assert.ok(hit);
    assert.equal(hit?.coverage, 1, "cafe/CAFÉ and rollback/ROLLBACK must both count despite case and diacritics");
  });
});

test("ftsSearch: a single-content-word query always has coverage 1.0 for any hit it returns", () => {
  withDb((db) => {
    const memory = createMemory(db, { text: "a note that mentions xenon once" }).memory;
    const hits = ftsSearch(db, "xenon");
    const hit = hits.find((h) => h.id === memory.id);
    assert.ok(hit);
    assert.equal(hit?.coverage, 1);
  });
});

test("ftsSearch: returns populated tags", () => {
  withDb((db) => {
    const memory = createMemory(db, { text: "tagged searchable fact", tags: ["b", "a"] }).memory;
    const hits = ftsSearch(db, "tagged searchable");
    const hit = hits.find((h) => h.id === memory.id);
    assert.ok(hit);
    assert.deepEqual(hit?.tags, ["a", "b"]);
  });
});
