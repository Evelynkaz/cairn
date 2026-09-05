// Drives the SSE frame parser directly against raw byte streams, including
// a CRLF-framed one. Our own daemon (src/dashboard/api.ts) always writes
// LF-framed events and heartbeats, never CRLF -- but the SSE spec permits a
// producer to use CRLF, so the parser must handle it too rather than only
// being exercisable through a live connection to our own daemon.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  createSseFrameParser,
  parseSseEvent,
  getTimeline,
  getAudit,
  deleteEverything,
  putPrivacy,
  approveMemory,
  bulkOp,
} from "./api-client.js";

// The data-layer functions above all go through request(), which reads
// getToken() (backed by sessionStorage) and calls the global fetch() --
// neither exists in the node:test environment by default, so both are
// stubbed here for the duration of this file and restored afterward.
let originalFetch: typeof fetch;
let originalSessionStorage: Storage | undefined;

before(() => {
  originalFetch = globalThis.fetch;
  originalSessionStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  } as Storage;
});

after(() => {
  globalThis.fetch = originalFetch;
  globalThis.sessionStorage = originalSessionStorage as Storage;
});

test("getTimeline puts at in the query string", async () => {
  let capturedUrl = "";
  globalThis.fetch = (async (url: string | URL) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }) as typeof fetch;
  await getTimeline({ at: 12345 });
  assert.ok(capturedUrl.includes("at=12345"), capturedUrl);
});

test("an omitted optional parameter never becomes the literal string undefined", async () => {
  let capturedUrl = "";
  globalThis.fetch = (async (url: string | URL) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
  }) as typeof fetch;
  await getAudit({ action: "remember" });
  assert.ok(!capturedUrl.includes("undefined"), capturedUrl);
});

test("deleteEverything sends confirm: true", async () => {
  let capturedBody: unknown;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify({ memories: 0, episodes: 0, vectors: 0 }), { status: 200 });
  }) as typeof fetch;
  await deleteEverything();
  assert.deepEqual(capturedBody, { confirm: true });
});

test("putPrivacy sends the mode in the body", async () => {
  let capturedBody: unknown;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify({ mode: "on", source: "settings" }), { status: 200 });
  }) as typeof fetch;
  await putPrivacy("on");
  assert.deepEqual(capturedBody, { mode: "on" });
});

test("approveMemory posts to /api/memories/:id/approve with the approved flag in the body", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedBody: unknown;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedMethod = init?.method ?? "";
    capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify({ id: "mem_1", approved: true }), { status: 200 });
  }) as typeof fetch;
  await approveMemory("mem 1", true);
  assert.equal(capturedMethod, "POST");
  assert.ok(capturedUrl.endsWith("/api/memories/mem%201/approve"), capturedUrl);
  assert.deepEqual(capturedBody, { approved: true });
});

test("bulkOp with approve sends the op and ids", async () => {
  let capturedBody: unknown;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify({ op: "approve", results: [], count: 0 }), { status: 200 });
  }) as typeof fetch;
  await bulkOp("approve", ["a", "b"]);
  assert.deepEqual(capturedBody, { op: "approve", ids: ["a", "b"] });
});

// A CRLF-framed heartbeat followed by a CRLF-framed real event -- a
// hypothetical CRLF producer, not a shape our own daemon emits.
const HEARTBEAT = ":\r\n\r\n";
const REAL_EVENT = 'data: {"type":"updated"}\r\n\r\n';
const RAW = HEARTBEAT + REAL_EVENT;

test("naive indexOf('\\n\\n') splitting never finds a boundary in a CRLF stream", () => {
  // This is exactly the old parser's loop body, run against a hypothetical
  // CRLF-framed producer's bytes.
  let buffer = RAW;
  const frames: string[] = [];
  let sepIndex = buffer.indexOf("\n\n");
  while (sepIndex >= 0) {
    frames.push(buffer.slice(0, sepIndex));
    buffer = buffer.slice(sepIndex + 2);
    sepIndex = buffer.indexOf("\n\n");
  }
  // Every "\n" in a CRLF stream is immediately preceded by "\r", so a
  // literal "\n\n" never occurs -- zero frames come out, and the whole
  // stream sits in `buffer` forever, growing on every future write. A naive
  // parser would silently lose the real event here.
  assert.deepEqual(frames, []);
  assert.equal(buffer, RAW);
});

test("the frame parser yields the event past a CRLF heartbeat", () => {
  const parser = createSseFrameParser();
  const events = parser.push(RAW);
  // The CRLF-to-LF normalization means the event reaches the caller instead
  // of vanishing, even though our own daemon never actually sends CRLF.
  assert.deepEqual(events, [{ type: "updated" }]);
});

test("a frame split across chunk boundaries, at an awkward offset, still parses", () => {
  const parser = createSseFrameParser();
  // Split mid-heartbeat and again mid-event, not on any convenient boundary.
  const cut1 = 2; // inside the heartbeat's "\r\n\r\n"
  const cut2 = RAW.length - 5; // inside the trailing "\r\n\r\n" of the real event
  const chunks = [RAW.slice(0, cut1), RAW.slice(cut1, cut2), RAW.slice(cut2)];

  const events = chunks.flatMap((chunk) => parser.push(chunk));
  assert.deepEqual(events, [{ type: "updated" }]);
});

test("multiple data: lines in one frame are concatenated with \\n per the SSE spec", () => {
  const event = parseSseEvent('data: {"type":\ndata: "updated"}');
  assert.deepEqual(event, { type: "updated" });
});

test("a comment-only frame (a bare heartbeat) yields no event", () => {
  assert.equal(parseSseEvent(":"), null);
  const parser = createSseFrameParser();
  assert.deepEqual(parser.push(HEARTBEAT), []);
});
