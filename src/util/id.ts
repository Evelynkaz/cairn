import { randomBytes } from "node:crypto";

// 12-bit rand_a field used as a monotonic counter within a millisecond.
const COUNTER_MAX = 0x0fff;

let lastTimestampMs = 0;
let counter = 0;

function randomCounterSeed(): number {
  const buf = randomBytes(2);
  // Seed only in the low half of the 12-bit space (RFC 9562 §6.2): seeding
  // across the full range halves the average per-millisecond headroom and
  // pushes the embedded timestamp ahead of the wall clock under sustained
  // bursts.
  return ((buf[0]! << 8) | buf[1]!) & 0x07ff;
}

function toHex(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * RFC 9562 UUIDv7 with the monotonic-counter method: within the same
 * millisecond the 12-bit rand_a field is used as an incrementing counter so
 * that ids generated back-to-back still sort in ascending lexicographic
 * order (required by keyset pagination on (created_at, id)).
 */
export function uuidv7(): string {
  let timestampMs = Date.now();

  if (timestampMs <= lastTimestampMs) {
    // Same millisecond, or the system clock moved backward: stay on the
    // last timestamp and advance the counter instead of going backward.
    timestampMs = lastTimestampMs;
    counter += 1;
    if (counter > COUNTER_MAX) {
      // Counter exhausted: force the clock forward by 1ms rather than wrap.
      timestampMs += 1;
      counter = randomCounterSeed();
    }
  } else {
    counter = randomCounterSeed();
  }

  lastTimestampMs = timestampMs;

  const ts = BigInt(timestampMs);
  const randB = randomBytes(8);
  const bytes = new Uint8Array(16);

  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  bytes[6] = 0x70 | ((counter >> 8) & 0x0f); // version 7 + rand_a[11:8]
  bytes[7] = counter & 0xff; // rand_a[7:0]

  bytes[8] = 0x80 | (randB[0]! & 0x3f); // variant 10 + rand_b top bits
  bytes[9] = randB[1]!;
  bytes[10] = randB[2]!;
  bytes[11] = randB[3]!;
  bytes[12] = randB[4]!;
  bytes[13] = randB[5]!;
  bytes[14] = randB[6]!;
  bytes[15] = randB[7]!;

  return toHex(bytes);
}

const UUID_V7_RE = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Parses the 48-bit big-endian Unix-ms timestamp embedded in the first 12
 * hex digits of a UUIDv7. `created_at` must be DERIVED from the id rather
 * than read from a second `Date.now()` call, otherwise a backward clock
 * step can produce a row whose `created_at` is lower while its id is
 * higher, which breaks `ORDER BY created_at, id` keyset pagination by
 * permanently skipping that row.
 */
export function timestampFromUuidv7(id: string): number {
  const match = UUID_V7_RE.exec(id);
  if (!match) {
    // Deliberately does not echo `id`: it is attacker-controlled input (an
    // archive's memory/episode id, hostile-input-tested end to end), and
    // this error can surface all the way into an MCP client's context.
    // Callers that need the offending value in a message must add their
    // own safely-bounded context around this call rather than rely on it
    // being here.
    throw new Error("not a canonical UUIDv7");
  }
  const hex = match[1]! + match[2]!;
  return Number(BigInt(`0x${hex}`));
}
