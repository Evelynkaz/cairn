import { test } from "node:test";
import assert from "node:assert/strict";
import { cosineSimilarity, mmr, type MmrCandidate } from "./mmr.js";

test("cosineSimilarity of identical vectors is 1", () => {
  const a = new Float32Array([1, 2, 3]);
  assert.equal(cosineSimilarity(a, a), 1);
});

test("cosineSimilarity of orthogonal vectors is 0", () => {
  const a = new Float32Array([1, 0]);
  const b = new Float32Array([0, 1]);
  assert.equal(cosineSimilarity(a, b), 0);
});

test("cosineSimilarity of opposite vectors is -1", () => {
  const a = new Float32Array([1, 0]);
  const b = new Float32Array([-1, 0]);
  assert.equal(cosineSimilarity(a, b), -1);
});

test("cosineSimilarity does not assume normalisation", () => {
  const a = new Float32Array([2, 0]);
  const b = new Float32Array([5, 0]);
  assert.equal(cosineSimilarity(a, b), 1);
});

test("cosineSimilarity throws a descriptive error on length mismatch", () => {
  const a = new Float32Array([1, 2]);
  const b = new Float32Array([1, 2, 3]);
  assert.throws(() => cosineSimilarity(a, b), /length mismatch/);
});

test("k <= 0 returns an empty array", () => {
  const candidates: MmrCandidate[] = [{ id: "a", relevance: 1, vector: null }];
  assert.deepEqual(mmr(candidates, 0), []);
  assert.deepEqual(mmr(candidates, -5), []);
});

test("k clamps to the candidate count", () => {
  const candidates: MmrCandidate[] = [
    { id: "a", relevance: 0.9, vector: null },
    { id: "b", relevance: 0.5, vector: null },
  ];
  assert.equal(mmr(candidates, 100).length, 2);
});

test("two near-identical vectors plus one different: lambda 0.7 picks the different one second, lambda 1.0 (pure relevance) does not", () => {
  const a: MmrCandidate = { id: "a", relevance: 0.9, vector: new Float32Array([1, 0]) };
  const b: MmrCandidate = { id: "b", relevance: 0.85, vector: new Float32Array([0.99, 0.141]) }; // ~8 degrees from a
  const c: MmrCandidate = { id: "c", relevance: 0.8, vector: new Float32Array([0, 1]) }; // orthogonal to a

  const withDiversity = mmr([a, b, c], 3, 0.7);
  assert.deepEqual(withDiversity, ["a", "c", "b"]);

  const pureRelevance = mmr([a, b, c], 3, 1.0);
  assert.deepEqual(pureRelevance, ["a", "b", "c"]);
});

test("all-null vectors degrades to plain relevance order", () => {
  const candidates: MmrCandidate[] = [
    { id: "low", relevance: 0.2, vector: null },
    { id: "high", relevance: 0.9, vector: null },
    { id: "mid", relevance: 0.5, vector: null },
  ];
  assert.deepEqual(mmr(candidates, 3), ["high", "mid", "low"]);
});

test("a mix of null and non-null vectors: null candidates are neither promoted nor dropped", () => {
  const a: MmrCandidate = { id: "a", relevance: 0.9, vector: new Float32Array([1, 0]) };
  // near-identical to a: heavily penalised for similarity once a is selected
  const aLike: MmrCandidate = { id: "aLike", relevance: 0.85, vector: new Float32Array([1, 0.01]) };
  // no vector: cannot be penalised for similarity to a, but also cannot use
  // similarity to dodge the penalty — it competes on relevance alone
  const noVec: MmrCandidate = { id: "noVec", relevance: 0.6, vector: null };

  const result = mmr([a, aLike, noVec], 3, 0.7);
  assert.deepEqual(result, ["a", "noVec", "aLike"]);
});

// ALSO FIX regression: `maxSim` used to have no floor at 0, so an
// anti-correlated (negative cosine similarity) candidate scored a BONUS in
// `-(1-lambda)*maxSim` instead of a penalty. Fails without the fix: the
// anti-correlated candidate is picked ahead of an equally-relevant,
// genuinely-unrelated (orthogonal, similarity 0) one.
test("a negative (anti-correlated) similarity is floored at 0, never rewarded as a diversity bonus", () => {
  const a: MmrCandidate = { id: "a", relevance: 0.9, vector: new Float32Array([1, 0]) };
  // Equal relevance, one orthogonal (similarity 0) and one opposite
  // (similarity -1) to `a`. An un-floored maxSim would let the opposite
  // one's negative similarity flip sign into a BONUS once `a` is selected,
  // ranking it ahead of the orthogonal one purely for being anti-correlated.
  const orthogonal: MmrCandidate = { id: "orthogonal", relevance: 0.5, vector: new Float32Array([0, 1]) };
  const opposite: MmrCandidate = { id: "opposite", relevance: 0.5, vector: new Float32Array([-1, 0]) };

  const result = mmr([a, orthogonal, opposite], 3, 0.5);
  assert.deepEqual(result, ["a", "orthogonal", "opposite"]);
});

// ALSO FIX, documented rather than changed (see mmr.ts's module comment for
// why the alternative -- estimating a null pairing from observed real-vs-
// real similarities -- was tried and rejected as fragile on small samples):
// a null vector is scored at a flat 0 similarity against every other
// candidate, which is EXPLICITLY NOT NEUTRAL once real embeddings are in
// the mix (real unrelated pairs already sit around 0.6-0.75 similarity
// here), so an un-embedded candidate is favoured for diversity purposes
// over an equally- or more-relevant embedded one, purely for lacking a
// vector. This pins that documented behaviour so a future change to it is
// deliberate, not accidental.
test("a null vector is favoured for diversity over an embedded one of higher relevance (documented, not neutral)", () => {
  const a: MmrCandidate = { id: "a", relevance: 0.9, vector: new Float32Array([1, 0]) };
  // Simulates the "real unrelated pairs still sit around 0.6-0.75
  // similarity" baseline this project's local embeddings exhibit.
  const related: MmrCandidate = { id: "related", relevance: 0.6, vector: new Float32Array([0.7, 0.714142843]) };
  const noVec: MmrCandidate = { id: "noVec", relevance: 0.55, vector: null };

  const result = mmr([a, related, noVec], 3, 0.5);
  assert.deepEqual(result, ["a", "noVec", "related"]);
});

// ALSO FIX regression: `lambda` was never clamped, so `NaN` made every
// `mmrScore` comparison false, leaving `bestIndex` at -1 and throwing on
// `remaining[-1]`, and a negative lambda inverted the relevance/diversity
// trade-off instead of just mis-weighting it.
test("lambda is clamped to [0, 1]: NaN and out-of-range values never throw or invert ranking", () => {
  const candidates: MmrCandidate[] = [
    { id: "high", relevance: 0.9, vector: null },
    { id: "low", relevance: 0.1, vector: null },
  ];
  assert.deepEqual(mmr(candidates, 2, Number.NaN), ["high", "low"]);
  assert.deepEqual(mmr(candidates, 2, -1), ["high", "low"]);
  assert.deepEqual(mmr(candidates, 2, 2), ["high", "low"]);
});
