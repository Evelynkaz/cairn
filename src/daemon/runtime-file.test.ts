// Exercises the daemon.json rendezvous file in isolation from the daemon
// itself: every function here takes an explicit `home` directory, so these
// tests never touch (or depend on) the developer's real ~/.cairn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateToken,
  isDaemonAlive,
  readRuntimeFile,
  removeRuntimeFile,
  runtimeFilePath,
  writeRuntimeFile,
} from "./runtime-file.js";
import type { RuntimeInfo } from "./runtime-file.js";

function uniqueTempDir(): string {
  return mkdtempSync(join(tmpdir(), "cairn-daemon-test-"));
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = uniqueTempDir();
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function sampleInfo(overrides: Partial<RuntimeInfo> = {}): RuntimeInfo {
  return { pid: process.pid, port: 8787, token: generateToken(), startedAt: Date.now(), version: "0.1.0", ...overrides };
}

test("generateToken produces distinct, non-trivial hex tokens", () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("writeRuntimeFile then readRuntimeFile round-trips", () => {
  withTempDir((dir) => {
    const info = sampleInfo();
    writeRuntimeFile(info, dir);
    assert.deepEqual(readRuntimeFile(dir), info);
  });
});

test("the runtime file is mode 0600 on POSIX; on Windows the mode bit is a no-op", () => {
  withTempDir((dir) => {
    writeRuntimeFile(sampleInfo(), dir);
    const stat = statSync(runtimeFilePath(dir));
    if (process.platform !== "win32") {
      assert.equal(stat.mode & 0o777, 0o600);
    } else {
      // No POSIX permission bits on NTFS -- just confirm the file exists;
      // the protection there is the user profile directory, not this mode.
      assert.ok(stat.isFile());
    }
  });
});

test("readRuntimeFile returns null when the file is absent", () => {
  withTempDir((dir) => {
    assert.equal(readRuntimeFile(dir), null);
  });
});

test("readRuntimeFile returns null (never throws) on a corrupt file", () => {
  withTempDir((dir) => {
    writeRuntimeFile(sampleInfo(), dir);
    // Overwrite with unparseable content, simulating a torn write from a
    // crash mid-save.
    writeFileSync(runtimeFilePath(dir), "{not json");
    assert.equal(readRuntimeFile(dir), null);
  });
});

test("removeRuntimeFile tolerates an already-absent file", () => {
  withTempDir((dir) => {
    assert.doesNotThrow(() => removeRuntimeFile(dir));
    writeRuntimeFile(sampleInfo(), dir);
    assert.ok(existsSync(runtimeFilePath(dir)));
    removeRuntimeFile(dir);
    assert.ok(!existsSync(runtimeFilePath(dir)));
    assert.doesNotThrow(() => removeRuntimeFile(dir));
  });
});

test("isDaemonAlive is false for a runtime file pointing at a dead pid", async () => {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = child.pid;
  assert.ok(typeof deadPid === "number" && deadPid > 0, "child process must have reported a pid");
  const alive = await isDaemonAlive(sampleInfo({ pid: deadPid, port: 65535 }));
  assert.equal(alive, false);
});

test("isDaemonAlive is false for a live pid whose port is closed", async () => {
  const server = createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const alive = await isDaemonAlive(sampleInfo({ pid: process.pid, port }));
  assert.equal(alive, false);
});

test("isDaemonAlive is true for a live pid whose port answers", async () => {
  const server = createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  try {
    const alive = await isDaemonAlive(sampleInfo({ pid: process.pid, port }));
    assert.equal(alive, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
