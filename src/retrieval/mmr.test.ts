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
