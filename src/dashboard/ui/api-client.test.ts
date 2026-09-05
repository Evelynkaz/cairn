// Drives the SSE frame parser directly against raw byte streams, including
// a CRLF-framed one. Our own daemon (src/dashboard/api.ts) always writes
// LF-framed events and heartbeats, never CRLF -- but the SSE spec permits a
// producer to use CRLF, so the parser must handle it too rather than only
// being exercisable through a live connection to our own daemon.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSseFrameParser, parseSseEvent } from "./api-client.js";

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
