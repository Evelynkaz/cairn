// Test-only helpers. Dev-only: exclude this module from the published
// package in the packaging milestone.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempDir(prefix = "cairn-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

// Synchronous only: cleans up the temp dir right after `fn` returns, which
// would race a still-running async `fn` and delete the directory out from
// under it. If `fn` returns a thenable, that is a caller bug -- fail loudly
// instead of silently racing; use withTempDirAsync for an async callback.
export function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = makeTempDir();
  try {
    const result = fn(dir);
    if (isThenable(result)) {
      throw new Error("withTempDir: fn returned a thenable -- use withTempDirAsync instead");
    }
    return result;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Best-effort: never mask the real failure from fn() with a cleanup error.
    }
  }
}

// Async-aware: awaits `fn` before cleaning up the temp dir, so the directory
// stays alive for the whole duration of an async callback instead of being
// deleted out from under it (the bug withTempDir now throws on instead of
// racing).
export async function withTempDirAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = makeTempDir();
  try {
    return await fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Best-effort: never mask the real failure from fn() with a cleanup error.
    }
  }
}

export function tempDbPath(dir: string): string {
  return join(dir, "test.db");
}
