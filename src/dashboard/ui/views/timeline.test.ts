// Pure, DOM-free helpers from timeline.ts: the `datetime-local`
// input <-> epoch conversion, exercised as a round-trip and against its
// invalid-input cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { epochToLocalInputValue, localInputValueToEpoch } from "./timeline.js";

test("epochToLocalInputValue -> localInputValueToEpoch round-trips to the same minute", () => {
  const original = new Date(2026, 5, 15, 9, 30, 0, 0).getTime();
  const value = epochToLocalInputValue(original);
  const back = localInputValueToEpoch(value);
  assert.equal(back, original);
});

test("localInputValueToEpoch: empty string returns null", () => {
  assert.equal(localInputValueToEpoch(""), null);
});

test("localInputValueToEpoch: date with no time part returns null", () => {
  assert.equal(localInputValueToEpoch("2026-01"), null);
});

test("localInputValueToEpoch: garbage returns null", () => {
  assert.equal(localInputValueToEpoch("garbage"), null);
});
