// Pure, DOM-free helpers from stats.ts: the bar-chart width calculation and
// the empty-store predicate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { barWidthPercent, isEmpty } from "./stats.js";
import type { StatsResult } from "../api-client.js";

test("barWidthPercent: max of 0 is a divide-by-zero guard, not NaN%", () => {
  assert.equal(barWidthPercent(0, 0), "0%");
  assert.equal(barWidthPercent(5, 0), "0%");
});

test("barWidthPercent: count equal to max is 100%", () => {
  assert.equal(barWidthPercent(7, 7), "100%");
});

test("barWidthPercent: rounds to the nearest percent", () => {
  assert.equal(barWidthPercent(1, 3), "33%");
  assert.equal(barWidthPercent(2, 3), "67%");
});

function makeStats(overrides: Partial<StatsResult>): StatsResult {
  return {
    liveMemories: 0,
    episodes: 0,
    deletedMemories: 0,
    supersededMemories: 0,
    redactedMemories: 0,
    recentActivity: 0,
    scopes: [],
    topTags: [],
    vectors: false,
    journalMode: "wal",
    oldestCreatedAt: null,
    newestCreatedAt: null,
    redactions: [],
    ...overrides,
  };
}

test("isEmpty: a genuinely empty store", () => {
  assert.equal(isEmpty(makeStats({})), true);
});

test("isEmpty: false when there are live memories", () => {
  assert.equal(isEmpty(makeStats({ liveMemories: 1 })), false);
});

test("isEmpty: false when there are only deleted memories", () => {
  assert.equal(isEmpty(makeStats({ deletedMemories: 1 })), false);
});

test("isEmpty: false when there are only superseded memories", () => {
  assert.equal(isEmpty(makeStats({ supersededMemories: 1 })), false);
});

test("isEmpty: false when there are only episodes", () => {
  assert.equal(isEmpty(makeStats({ episodes: 1 })), false);
});
