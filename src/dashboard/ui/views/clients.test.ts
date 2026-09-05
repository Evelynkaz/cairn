// Pure, DOM-free helpers from clients.ts: joining the clients/stats arrays
// GET /api/clients returns (not guaranteed same length or order), and the
// relative-time formatter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRows, formatRelative } from "./clients.js";
import type { ClientsResult } from "../api-client.js";

test("buildRows: a client with no matching stats row defaults reads/writes to 0", () => {
  const result: ClientsResult = {
    clients: [{ id: "a", name: "Alpha", firstSeen: 1, lastSeen: 2, enabled: true }],
    stats: [],
  };
  const rows = buildRows(result);
  assert.deepEqual(rows, [
    { id: "a", name: "Alpha", firstSeen: 1, lastSeen: 2, enabled: true, reads: 0, writes: 0 },
  ]);
});

test("buildRows: a stats row with no matching client yields enabled: null", () => {
  const result: ClientsResult = {
    clients: [],
    stats: [{ sourceClient: "ghost", reads: 3, writes: 1 }],
  };
  const rows = buildRows(result);
  assert.deepEqual(rows, [
    { id: "ghost", name: "ghost", firstSeen: null, lastSeen: null, enabled: null, reads: 3, writes: 1 },
  ]);
});

test("buildRows: both a client and its stats row present are merged", () => {
  const result: ClientsResult = {
    clients: [{ id: "a", name: "Alpha", firstSeen: 1, lastSeen: 2, enabled: false }],
    stats: [{ sourceClient: "a", reads: 5, writes: 7 }],
  };
  const rows = buildRows(result);
  assert.deepEqual(rows, [
    { id: "a", name: "Alpha", firstSeen: 1, lastSeen: 2, enabled: false, reads: 5, writes: 7 },
  ]);
});

test("buildRows: empty inputs yield no rows", () => {
  assert.deepEqual(buildRows({ clients: [], stats: [] }), []);
});

test("buildRows: name falls back to id when the client name is empty", () => {
  const result: ClientsResult = {
    clients: [{ id: "a", name: "", firstSeen: 0, lastSeen: 0, enabled: true }],
    stats: [],
  };
  const rows = buildRows(result);
  assert.equal(rows[0]?.name, "a");
});

test("formatRelative: null timestamp", () => {
  assert.equal(formatRelative(null, Date.now()), "—");
});

test("formatRelative: just under a minute is 'just now'", () => {
  const now = 1_000_000;
  assert.equal(formatRelative(now - 59_000, now), "just now");
});

test("formatRelative: exactly a minute is minutes, not 'just now'", () => {
  const now = 1_000_000;
  assert.equal(formatRelative(now - 60_000, now), "1 minute ago");
});

test("formatRelative: just under an hour is minutes", () => {
  const now = 10_000_000;
  assert.equal(formatRelative(now - 59 * 60_000, now), "59 minutes ago");
});

test("formatRelative: exactly an hour is hours", () => {
  const now = 10_000_000;
  assert.equal(formatRelative(now - 60 * 60_000, now), "1 hour ago");
});

test("formatRelative: just under a day is hours", () => {
  const now = 100_000_000;
  assert.equal(formatRelative(now - 23 * 60 * 60_000, now), "23 hours ago");
});

test("formatRelative: exactly a day is days", () => {
  const now = 100_000_000;
  assert.equal(formatRelative(now - 24 * 60 * 60_000, now), "1 day ago");
});
