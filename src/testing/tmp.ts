// Test-only helpers. Dev-only: exclude this module from the published
// package in the packaging milestone.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempDir(prefix = "cairn-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = makeTempDir();
  try {
    return fn(dir);
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
