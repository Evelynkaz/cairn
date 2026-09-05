// Pure, DOM-free helpers from audit.ts: the local-day boundary math (fixed
// here for a DST bug, see untilBound's comment) and the details formatter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startOfLocalDay, untilBound, formatDetails } from "./audit.js";

function withTz(tz: string, fn: () => void): void {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

test("startOfLocalDay returns local midnight for a calendar day", () => {
  const ms = startOfLocalDay("2026-03-15");
  const d = new Date(ms);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 2);
  assert.equal(d.getDate(), 15);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
});

test("untilBound on a normal (non-DST) day is the last millisecond of that day", () => {
  withTz("America/New_York", () => {
    const bound = untilBound("2026-03-10");
    const nextMidnight = new Date(2026, 2, 11, 0, 0, 0, 0).getTime();
    assert.equal(bound, nextMidnight - 1);
  });
});

test("untilBound on a DST fall-back day (25-hour day) still lands on next local midnight", () => {
  // Europe/Berlin falls back on 2026-10-25: that local day has 25 hours.
  // The old `startOfLocalDay(untilDate) + MS_PER_DAY - 1` bound would land
  // one hour early (23:00 local instead of the correct next midnight),
  // silently dropping every entry logged in the last hour of the day.
  withTz("Europe/Berlin", () => {
    const bound = untilBound("2026-10-25");
    const nextMidnight = new Date(2026, 9, 26, 0, 0, 0, 0).getTime();
    assert.equal(bound, nextMidnight - 1);
  });
});

test("untilBound on a DST spring-forward day (23-hour day) still lands on next local midnight", () => {
  // Europe/Berlin springs forward on 2026-03-29: that local day has 23
  // hours. The old constant-24h bound would land one hour into the next
  // day, over-including entries that belong to the following day.
  withTz("Europe/Berlin", () => {
    const bound = untilBound("2026-03-29");
    const nextMidnight = new Date(2026, 2, 30, 0, 0, 0, 0).getTime();
    assert.equal(bound, nextMidnight - 1);
  });
});

test("untilBound returns null for empty or invalid input", () => {
  assert.equal(untilBound(""), null);
  assert.equal(untilBound("garbage"), null);
});

test("formatDetails: null", () => {
  assert.equal(formatDetails(null), "—");
});

test("formatDetails: empty object", () => {
  assert.equal(formatDetails({}), "—");
});

test("formatDetails: populated object", () => {
  assert.equal(formatDetails({ a: 1, b: "x" }), JSON.stringify({ a: 1, b: "x" }));
});
