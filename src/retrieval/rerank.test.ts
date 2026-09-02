import { test } from "node:test";
import assert from "node:assert/strict";
import { rerank, DEFAULT_WEIGHTS, type RerankItem } from "./rerank.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function item(overrides: Partial<RerankItem> & { id: string }): RerankItem {
  return {
    relevance: 0,
    createdAt: 0,
    importance: 0,
    lastAccessed: null,
    accessCount: 0,
    ...overrides,
  };
}

test("recency weight only: an item one half-life old scores exactly half of a brand-new item", () => {
  const now = 10 * DAY_MS;
  const halfLifeMs = 7 * DAY_MS;
  const weights = { relevance: 0, recency: 1, importance: 0, access: 0, halfLifeMs };

  const [fresh, halfLife] = rerank(
    [item({ id: "fresh", createdAt: now }), item({ id: "halfLife", createdAt: now - halfLifeMs })],
    now,
    weights,
  );

  assert.equal(fresh!.score, 1);
  assert.equal(halfLife!.score, 0.5);
  assert.equal(halfLife!.score, fresh!.score / 2);
});

test("importance weight only: ordering follows importance", () => {
  const now = 0;
  const weights = { relevance: 0, recency: 0, importance: 1, access: 0 };

  const result = rerank(
    [
      item({ id: "low", importance: 0.1 }),
      item({ id: "high", importance: 0.9 }),
      item({ id: "mid", importance: 0.5 }),
    ],
    now,
    weights,
  );

  const sorted = [...result].sort((a, b) => b.score - a.score);
  assert.deepEqual(
    sorted.map((r) => r.id),
    ["high", "mid", "low"],
  );
});

test("access boost saturates: accessCount 1000 does not overtake a large relevance gap", () => {
  const now = 1000 * DAY_MS;

  const [relevant, overAccessed] = rerank(
    [
      item({ id: "relevant", relevance: 0.9, accessCount: 0, lastAccessed: null }),
      item({ id: "overAccessed", relevance: 0.05, accessCount: 1000, lastAccessed: now }),
    ],
    now,
  );

  assert.ok(relevant!.score > overAccessed!.score, `expected relevant (${relevant!.score}) > overAccessed (${overAccessed!.score})`);
});

test("access boost is bounded well below 1 even for a huge, freshly-accessed count", () => {
  const now = 0;
  const [result] = rerank([item({ id: "a", accessCount: 1_000_000, lastAccessed: now })], now);
  assert.ok(result!.parts.access < DEFAULT_WEIGHTS.access);
});

test("parts sum to the score under arbitrary weights", () => {
  const now = 5 * DAY_MS;
  const weights = { relevance: 0.4, recency: 0.3, importance: 0.2, access: 0.1 };
  const [result] = rerank(
    [item({ id: "a", relevance: 0.7, importance: 0.6, createdAt: 0, accessCount: 4, lastAccessed: 3 * DAY_MS })],
    now,
    weights,
  );

  const sum = result!.parts.relevance + result!.parts.recency + result!.parts.importance + result!.parts.access;
  assert.equal(sum, result!.score);
});

test("out-of-range relevance and importance are clamped into 0..1", () => {
  const now = 0;
  const weights = { relevance: 1, recency: 0, importance: 1, access: 0 };
  const [tooHigh, tooLow] = rerank(
    [
      item({ id: "tooHigh", relevance: 5, importance: -3, createdAt: now }),
      item({ id: "tooLow", relevance: -1, importance: 10, createdAt: now }),
    ],
    now,
    weights,
  );

  assert.equal(tooHigh!.parts.relevance, 1);
  assert.equal(tooHigh!.parts.importance, 0);
  assert.equal(tooLow!.parts.relevance, 0);
  assert.equal(tooLow!.parts.importance, 1);
});

test("rerank is pure: same inputs produce identical output and never mutate the input array", () => {
  const items = [item({ id: "a", relevance: 0.5, importance: 0.5, accessCount: 3, lastAccessed: 1 })];
  const snapshot = JSON.parse(JSON.stringify(items));
  const now = 42;

  const first = rerank(items, now);
  const second = rerank(items, now);

  assert.deepEqual(items, snapshot);
  assert.deepEqual(first, second);
});
