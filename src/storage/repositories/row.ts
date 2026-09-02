// Typed coercion from driver Rows (`Record<string, SqlValue>`) into the
// domain layer. Every helper throws a descriptive error naming the column
// on a shape mismatch, so a schema drift surfaces as a named error instead
// of `undefined` silently flowing into repository code.

import type { Row, SqlValue } from "../driver/index.js";

function describe(value: SqlValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return `${typeof value} (${String(value)})`;
}

export function str(row: Row, col: string): string {
  const v = row[col];
  if (typeof v !== "string") {
    throw new Error(`column "${col}": expected string, got ${describe(v)}`);
  }
  return v;
}

export function strOrNull(row: Row, col: string): string | null {
  const v = row[col];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") {
    throw new Error(`column "${col}": expected string or null, got ${describe(v)}`);
  }
  return v;
}

export function num(row: Row, col: string): number {
  const v = row[col];
  if (typeof v === "number") return v;
  if (typeof v === "bigint") {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`column "${col}": bigint value out of safe integer range: ${v}`);
    }
    return Number(v);
  }
  throw new Error(`column "${col}": expected number, got ${describe(v)}`);
}

export function numOrNull(row: Row, col: string): number | null {
  const v = row[col];
  if (v === null || v === undefined) return null;
  return num(row, col);
}

export function bool(row: Row, col: string): boolean {
  const v = row[col];
  if (v === 0 || v === 0n) return false;
  if (v === 1 || v === 1n) return true;
  throw new Error(`column "${col}": expected 0/1, got ${describe(v)}`);
}

// Parses a TEXT column into a plain JSON object, tolerating an empty or
// absent value by returning `{}` rather than throwing.
export function json(row: Row, col: string): Record<string, unknown> {
  const v = row[col];
  if (v === null || v === undefined || v === "") return {};
  if (typeof v !== "string") {
    throw new Error(`column "${col}": expected JSON text, got ${describe(v)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`column "${col}": invalid JSON (${message})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`column "${col}": JSON did not parse to an object`);
  }
  return parsed as Record<string, unknown>;
}
