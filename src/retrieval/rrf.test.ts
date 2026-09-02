import { test } from "node:test";
import assert from "node:assert/strict";
import { rrfFuse, RRF_K } from "./rrf.js";

test("rrfFuse with zero lists returns nothing", () => {
  assert.deepEqual(rrfFuse([]), []);
});

test("rrfFuse with a single empty list returns nothing", () => {
  assert.deepEqual(rrfFuse([[]]), []);
});

test("rrfFuse with a single list preserves its order with rank-only scores", () => {
  const result = rrfFuse([["a", "b", "c"]]);
  assert.deepEqual(
    result.map((r) => r.id),
    ["a", "b", "c"],
  );
  assert.equal(result[0]!.score, 1 / (RRF_K + 1));
  assert.deepEqual(result[0]!.ranks, [1]);
  assert.equal(result[2]!.score, 1 / (RRF_K + 3));
});

test("rrfFuse hand-computed scores for two lists with default k", () => {
  const result = rrfFuse([
    ["a", "b", "c"],
    ["b", "c", "a"],
  ]);

  const expected = new Map([
    ["a", 1 / (RRF_K + 1) + 1 / (RRF_K + 3)],
    ["b", 1 / (RRF_K + 2) + 1 / (RRF_K + 1)],
    ["c", 1 / (RRF_K + 3) + 1 / (RRF_K + 2)],
  ]);

  for (const item of result) {
    assert.equal(item.score, expected.get(item.id));
  }

  // b (rank2+rank1) > a (rank1+rank3) > c (rank3+rank2)
  assert.deepEqual(
    result.map((r) => r.id),
    ["b", "a", "c"],
  );
});

test("rrfFuse records null for lists that do not contain the id", () => {
  const result = rrfFuse([["a"], ["b"]]);
  const a = result.find((r) => r.id === "a")!;
  const b = result.find((r) => r.id === "b")!;
  assert.deepEqual(a.ranks, [1, null]);
  assert.deepEqual(b.ranks, [null, 1]);
});

test("id ranked first in one list and absent elsewhere does NOT beat an id ranked third in every list, by design — RRF rewards multi-list consensus over a single top rank; for k > 0 this is mathematically guaranteed since 1/(k+1) < 2/(k+3)", () => {
  const result = rrfFuse([
    ["x", "f1", "y"],
    ["f2", "f3", "y"],
  ]);
  const x = result.find((r) => r.id === "x")!;
  const y = result.find((r) => r.id === "y")!;
  assert.equal(x.score, 1 / (RRF_K + 1));
  assert.equal(y.score, 1 / (RRF_K + 3) + 1 / (RRF_K + 3));
  assert.ok(y.score > x.score);
  assert.equal(result[0]!.id, "y");
});

test("id present in every list beats an id present in only one, all else similar rank", () => {
  const result = rrfFuse([
    ["everywhere", "onlyhere"],
    ["everywhere"],
    ["everywhere"],
  ]);
  assert.equal(result[0]!.id, "everywhere");
  assert.ok(result[0]!.score > result[1]!.score);
});

test("duplicate ids within one list: first occurrence wins, later ones ignored", () => {
  const result = rrfFuse([["a", "a", "b"]]);
  const a = result.find((r) => r.id === "a")!;
  const b = result.find((r) => r.id === "b")!;
  assert.equal(a.score, 1 / (RRF_K + 1));
  assert.deepEqual(a.ranks, [1]);
  assert.equal(b.score, 1 / (RRF_K + 2));
  assert.deepEqual(b.ranks, [2]);
});

test("ties break deterministically by best rank, then lexicographically by id, regardless of input list order", () => {
  const resultA = rrfFuse([["x"], ["y"]]);
  const resultB = rrfFuse([["y"], ["x"]]);

  assert.deepEqual(
    resultA.map((r) => r.id),
    ["x", "y"],
  );
  assert.deepEqual(
    resultB.map((r) => r.id),
    ["x", "y"],
  );
  assert.equal(resultA[0]!.score, resultA[1]!.score);
});

test("custom k changes the score magnitude but not the arithmetic", () => {
  const result = rrfFuse([["a"]], 0);
  assert.equal(result[0]!.score, 1 / (0 + 1));
});
