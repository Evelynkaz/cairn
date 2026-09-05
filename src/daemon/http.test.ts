// Exercises the HTTP primitives shared by server.ts and the (future)
// dashboard API in isolation, without starting a daemon: a fake
// IncomingMessage/ServerResponse is enough to drive readJsonBody/sendJson,
// and tokenMatches is pure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_REQUEST_BODY_BYTES, PayloadTooLargeError, readJsonBody, sendJson, tokenMatches } from "./http.js";

function fakeRequest(): { req: IncomingMessage; readable: Readable } {
  const readable = new Readable({ read() {} });
  return { req: readable as unknown as IncomingMessage, readable };
}

test("tokenMatches: equal strings match", () => {
  assert.equal(tokenMatches("secret-token", "secret-token"), true);
});

test("tokenMatches: differing string of the same length does not match", () => {
  assert.equal(tokenMatches("secret-tokea", "secret-token"), false);
});

test("tokenMatches: shorter string does not match", () => {
  assert.equal(tokenMatches("secret-toke", "secret-token"), false);
});

test("tokenMatches: longer string does not match", () => {
  assert.equal(tokenMatches("secret-tokenn", "secret-token"), false);
});

test("tokenMatches: empty string against empty string matches", () => {
  assert.equal(tokenMatches("", ""), true);
});

test("readJsonBody: parses a valid JSON body", async () => {
  const { req, readable } = fakeRequest();
  const promise = readJsonBody(req);
  readable.push(Buffer.from(JSON.stringify({ hello: "world" })));
  readable.push(null);
  assert.deepEqual(await promise, { hello: "world" });
});

test("readJsonBody: resolves undefined for an empty body", async () => {
  const { req, readable } = fakeRequest();
  const promise = readJsonBody(req);
  readable.push(null);
  assert.equal(await promise, undefined);
});

test("readJsonBody: rejects with a non-PayloadTooLargeError on malformed JSON", async () => {
  const { req, readable } = fakeRequest();
  const promise = readJsonBody(req);
  readable.push(Buffer.from("{not json"));
  readable.push(null);
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(!(err instanceof PayloadTooLargeError));
    return true;
  });
});

test("readJsonBody: rejects with PayloadTooLargeError when the body exceeds the cap", async () => {
  const { req, readable } = fakeRequest();
  const promise = readJsonBody(req);
  readable.push(Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1, "a"));
  await assert.rejects(promise, PayloadTooLargeError);
  readable.push(null);
});

test("readJsonBody: the request stream can still end after an oversize rejection without settling twice", async () => {
  const { req, readable } = fakeRequest();
  const promise = readJsonBody(req);
  readable.push(Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1, "a"));
  await assert.rejects(promise, PayloadTooLargeError);
  // Ending the stream after the rejection must not throw or settle the
  // promise a second time (there is nothing left to await, but a second
  // resolve/reject call would be a bug the "settled" guard exists to catch).
  readable.push(null);
  await new Promise((resolve) => readable.on("end", resolve));
});

test("sendJson: writes the status, content-type, and a body that parses back", () => {
  let status: number | undefined;
  let headers: Record<string, string> | undefined;
  let body: string | undefined;
  const spy = {
    writeHead(s: number, h: Record<string, string>) {
      status = s;
      headers = h;
    },
    end(b: string) {
      body = b;
    },
  } as unknown as ServerResponse;
  sendJson(spy, 200, { ok: true, n: 1 });
  assert.equal(status, 200);
  assert.equal(headers?.["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(body ?? ""), { ok: true, n: 1 });
});
