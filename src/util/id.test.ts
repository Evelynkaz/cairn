import { test } from "node:test";
import assert from "node:assert/strict";
import { timestampFromUuidv7, uuidv7 } from "./id.js";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("uuidv7 produces canonical lowercase hyphenated form", () => {
  const id = uuidv7();
  assert.match(id, UUID_V7_RE);
});

test("uuidv7 sets version nibble to 7 and variant bits to 10", () => {
  const id = uuidv7();
  const parts = id.split("-");
  assert.equal(parts[2]![0], "7");
  const variantNibble = parseInt(parts[3]![0]!, 16);
  assert.equal(variantNibble & 0b1100, 0b1000);
});

test("10000 consecutively generated ids are strictly increasing and unique", () => {
  const ids: string[] = [];
  for (let i = 0; i < 10000; i++) {
    ids.push(uuidv7());
  }

  const seen = new Set(ids);
  assert.equal(seen.size, ids.length, "ids must be unique");

  for (let i = 1; i < ids.length; i++) {
    assert.ok(ids[i - 1]! < ids[i]!, `expected ${ids[i - 1]} < ${ids[i]} at index ${i}`);
  }
});

// These timestamp tests share module-level generator state (lastTimestampMs,
// counter) with the 10,000-id burst test above: a burst that exhausts the
// ~2048-value per-millisecond counter headroom pushes the embedded
// timestamp ahead of the wall clock, so the upper bound needs slack beyond
// a single millisecond.
test("timestampFromUuidv7 returns the real generation time, not a constant", () => {
  const t0 = Date.now();
  const id = uuidv7();
  const t1 = Date.now();
  const ts = timestampFromUuidv7(id);
  assert.ok(ts >= t0 && ts <= t1 + 5, `expected ${t0} <= ${ts} <= ${t1 + 5}`);
});

test("timestampFromUuidv7 round-trips for several ids", () => {
  for (let i = 0; i < 5; i++) {
    const before = Date.now();
    const id = uuidv7();
    const after = Date.now();
    const ts = timestampFromUuidv7(id);
    assert.ok(ts >= before && ts <= after + 5);
  }
});

test("timestampFromUuidv7 throws on malformed or wrong-version input", () => {
  assert.throws(() => timestampFromUuidv7("not-a-uuid"));
  const wrongVersion = "01890a5d-ac96-4b3e-8a12-3456789abcde";
  assert.throws(() => timestampFromUuidv7(wrongVersion));
});

test("timestampFromUuidv7 accepts an uppercase canonical UUIDv7", () => {
  const id = uuidv7();
  const upper = id.toUpperCase();
  assert.equal(timestampFromUuidv7(upper), timestampFromUuidv7(id));
});
