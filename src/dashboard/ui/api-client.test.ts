// Drives the SSE frame parser directly with the daemon's actual byte
// stream (see src/dashboard/api.ts's heartbeat, ":\r\n\r\n" -- CRLF) rather
// than only being exercisable through a live connection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSseFrameParser, parseSseEvent } from "./api-client.js";

// A CRLF-framed heartbeat followed by a CRLF-framed real event -- the exact
// shape the daemon emits.
const HEARTBEAT = ":\r\n\r\n";
const REAL_EVENT = 'data: {"type":"updated"}\r\n\r\n';
const RAW = HEARTBEAT + REAL_EVENT;

test("before the fix: naive indexOf('\\n\\n') splitting never finds a boundary in a CRLF stream", () => {
  // This is exactly the old parser's loop body, run against the daemon's
  // real CRLF-framed bytes.
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
  // stream sits in `buffer` forever, growing on every future write. This is
  // the observed-before behaviour: the real event is silently lost.
  assert.deepEqual(frames, []);
  assert.equal(buffer, RAW);
});

test("after the fix: the frame parser yields the event past a CRLF heartbeat", () => {
  const parser = createSseFrameParser();
  const events = parser.push(RAW);
  // Observed after: the event reaches the caller instead of vanishing.
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
