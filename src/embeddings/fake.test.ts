import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeProvider } from "./fake.js";
import { assertEmbeddingShape } from "./types.js";

function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return 1 - dot;
}

function vectorLength(v: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    sumSq += x * x;
  }
  return Math.sqrt(sumSq);
}

test("fake provider is deterministic across two separate instances", async () => {
  const a = createFakeProvider();
  const b = createFakeProvider();
  const [va] = await a.embed(["hello world"]);
  const [vb] = await b.embed(["hello world"]);
  assert.ok(va);
  assert.ok(vb);
  assert.deepEqual(Array.from(va), Array.from(vb));
});

test("identical text yields distance 0; different texts yield distance well above 0", async () => {
  const provider = createFakeProvider();
  const [x1, x2, y] = await provider.embed(["same text", "same text", "a completely different string"]);
  assert.ok(x1 && x2 && y);
  assert.ok(Math.abs(cosineDistance(x1, x2)) < 1e-6, "identical text must produce distance ~0");
  assert.ok(cosineDistance(x1, y) > 0.1, "different texts must not collapse to near-identical vectors");
});

test("every returned vector has unit length", async () => {
  const provider = createFakeProvider({ dim: 16 });
  const vectors = await provider.embed(["one", "two", "three", ""]);
  for (const v of vectors) {
    assert.ok(Math.abs(vectorLength(v) - 1) < 1e-4, `vector length ${vectorLength(v)} is not ~1`);
  }
});

test("batch order is preserved for a 10-text batch", async () => {
  const provider = createFakeProvider();
  const texts = Array.from({ length: 10 }, (_, i) => `text-${i}`);
  const batched = await provider.embed(texts);

  const single: Float32Array[] = [];
  for (const text of texts) {
    const [v] = await createFakeProvider().embed([text]);
    assert.ok(v);
    single.push(v);
  }

  for (let i = 0; i < texts.length; i++) {
    assert.deepEqual(Array.from(batched[i] ?? []), Array.from(single[i] ?? []), `mismatch at index ${i}`);
  }
});

test("calls and textsEmbedded reflect real batching", async () => {
  const provider = createFakeProvider();
  assert.equal(provider.calls, 0);
  assert.equal(provider.textsEmbedded, 0);

  await provider.embed(["a", "b", "c"]);
  assert.equal(provider.calls, 1);
  assert.equal(provider.textsEmbedded, 3);

  await provider.embed(["d"]);
  assert.equal(provider.calls, 2);
  assert.equal(provider.textsEmbedded, 4);
});

test("failOn rejects embed for a matching text", async () => {
  const provider = createFakeProvider({ failOn: (text) => text === "poison" });
  await assert.rejects(() => provider.embed(["fine", "poison"]), /poison/);
});

test("latencyMs delays embed", async () => {
  const provider = createFakeProvider({ latencyMs: 30 });
  const start = Date.now();
  await provider.embed(["slow"]);
  assert.ok(Date.now() - start >= 25);
});

test("assertEmbeddingShape throws on a short batch, a long batch, and a wrong-length vector", () => {
  const dim = 4;
  const texts = ["a", "b", "c"];
  // Non-zero and correctly-sized, so it never accidentally trips the
  // degeneracy check while standing in for "some other, unrelated vector".
  const good = () => Float32Array.from({ length: dim }, (_, i) => i + 1);

  assert.throws(
    () => assertEmbeddingShape([good(), good()], texts, dim, "fake"),
    /provider "fake" returned 2 vectors for 3 input texts/,
  );
  assert.throws(
    () => assertEmbeddingShape([good(), good(), good(), good()], texts, dim, "fake"),
    /provider "fake" returned 4 vectors for 3 input texts/,
  );
  assert.throws(
    () => assertEmbeddingShape([good(), Float32Array.from([1, 0, 0]), good()], texts, dim, "fake"),
    /provider "fake" returned a vector of length 3 at index 1, expected dim 4/,
  );
});

test("assertEmbeddingShape throws on a zero (degenerate) vector", () => {
  const dim = 4;
  const texts = ["a", "b", "c"];
  const good = () => Float32Array.from({ length: dim }, (_, i) => i + 1);

  assert.throws(
    () => assertEmbeddingShape([good(), new Float32Array(dim), good()], texts, dim, "fake"),
    /provider "fake" returned a zero \(degenerate\) vector at index 1/,
  );
});

test("assertEmbeddingShape throws on a non-finite component, naming the component index", () => {
  const dim = 4;
  const texts = ["a", "b", "c"];
  const good = () => Float32Array.from({ length: dim }, (_, i) => i + 1);

  const withNaN = good();
  withNaN[2] = NaN;
  assert.throws(
    () => assertEmbeddingShape([good(), withNaN, good()], texts, dim, "fake"),
    /provider "fake" returned a non-finite component at batch index 1, component index 2/,
  );

  const withInfinity = good();
  withInfinity[3] = Infinity;
  assert.throws(
    () => assertEmbeddingShape([good(), withInfinity, good()], texts, dim, "fake"),
    /provider "fake" returned a non-finite component at batch index 1, component index 3/,
  );
});
