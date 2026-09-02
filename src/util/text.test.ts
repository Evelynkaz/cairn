import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { contentHash, normalizeForHash } from "./text.js";

test("whitespace and case differences hash equal", () => {
  const a = contentHash("  I  prefer\tVim\n");
  const b = contentHash("i prefer vim");
  assert.equal(a, b);
});

test("NFKC-equivalent strings hash equal", () => {
  const fullWidth = contentHash("\uFF21\uFF22\uFF23"); // fullwidth ABC
  const ascii = contentHash("abc");
  assert.equal(fullWidth, ascii);

  const composed = contentHash("caf\u00e9"); // precomposed e-acute
  const decomposed = contentHash("cafe\u0301"); // e + combining acute
  assert.equal(composed, decomposed);
});

test("different text hashes differ", () => {
  assert.notEqual(contentHash("hello"), contentHash("goodbye"));
});

test("hash is 64 lowercase hex characters", () => {
  const hash = contentHash("anything");
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test("hash is stable across calls", () => {
  assert.equal(contentHash("stable input"), contentHash("stable input"));
});

test("empty string does not throw", () => {
  assert.doesNotThrow(() => contentHash(""));
  assert.equal(normalizeForHash(""), "");
});

test("the version prefix is load-bearing", () => {
  assert.equal(contentHash("x"), createHash("sha256").update("v1\nx", "utf8").digest("hex"));
});

test("non-ASCII whitespace collapses", () => {
  assert.equal(contentHash("a\u00A0\u3000\uFEFFb"), contentHash("a b"));
});
