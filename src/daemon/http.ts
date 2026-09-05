// HTTP primitives shared by the daemon's MCP route (server.ts) and the
// dashboard API (built next). They live in one place on purpose: this
// project has already been bitten once by a security predicate (a
// constant-time token comparison) drifting between two copies, so the body
// cap and the constant-time token comparison get exactly one implementation
// here rather than a per-route copy that can drift again.

import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

// A request body this large is never a legitimate MCP payload; it is either
// a mistake or an attempt to exhaust memory before the JSON parser (or the
// SDK's own transport) ever gets a look at it. Applies to the one place
// this module reads a body itself (readJsonBody, below) -- an established
// session's ordinary traffic is read by the SDK's own transport instead.
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on a length mismatch, which would let a
  // wrong-length guess take a different (exception) path than a
  // wrong-content one -- compare lengths in plain code first so every
  // rejection reaches the same constant-time comparison and takes the same
  // amount of time regardless of how close the guess was.
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

// Distinguishes "body too large" from "malformed JSON" so the caller can
// answer 413 instead of 400 -- see MAX_REQUEST_BODY_BYTES above.
export class PayloadTooLargeError extends Error {}

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        // Reject immediately (so the caller can answer 413 without waiting
        // for the rest of the upload) but let the socket drain naturally
        // rather than destroying it: destroying `req` here tears down the
        // underlying connection before the 413 response can be written,
        // which reaches the client as a bare connection reset instead of an
        // HTTP response. Dropping (not buffering) chunks past this point is
        // what bounds memory -- nothing further is ever pushed to `chunks`.
        settled = true;
        reject(new PayloadTooLargeError(`request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}
