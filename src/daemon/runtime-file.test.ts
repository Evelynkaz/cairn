// Exercises the daemon.json rendezvous file in isolation from the daemon
// itself: every function here takes an explicit `home` directory, so these
// tests never touch (or depend on) the developer's real ~/.cairn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import type { Server as HttpServer } from "node:http";
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

test("writeRuntimeFile tightens a pre-existing 0644 file to 0600", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX file mode bits are not meaningful on Windows");
    return;
  }
  withTempDir((dir) => {
    const path = runtimeFilePath(dir);
    writeFileSync(path, "{}");
    chmodSync(path, 0o644);

    writeRuntimeFile(sampleInfo(), dir);

    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

test("writeRuntimeFile does not write the token through a symlink planted at the runtime file path", (t) => {
  if (process.platform === "win32") {
    t.skip("symlinks require elevated privilege to create on Windows by default");
    return;
  }
  withTempDir((dir) => {
    const path = runtimeFilePath(dir);
    const attackerTarget = join(dir, "attacker-target.json");
    writeFileSync(attackerTarget, "not touched");
    symlinkSync(attackerTarget, path);

    const info = sampleInfo();
    writeRuntimeFile(info, dir);

    assert.equal(readFileSync(attackerTarget, "utf8"), "not touched");
    assert.ok(!lstatSync(path).isSymbolicLink());
    assert.deepEqual(readRuntimeFile(dir), info);
  });
});

test("writeRuntimeFile does not leak its temp file when the final rename fails", () => {
  withTempDir((dir) => {
    const path = runtimeFilePath(dir);
    // A directory sitting at the destination makes the final renameSync
    // fail (EISDIR/EPERM), simulating any late failure after the temp file
    // was created -- the leaked-temp-file bug this guards against.
    mkdirSync(path);

    assert.throws(() => writeRuntimeFile(sampleInfo(), dir));

    const leftover = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftover, []);
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
  const server = createNetServer();
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

// A port answering is not enough: it must answer with the daemon's own
// /health shape AND the recorded pid, or identity is unproven (see the
// isDaemonAlive comment in runtime-file.ts).
test("isDaemonAlive is false for a foreign HTTP server on the recorded port, even though the pid is alive", async () => {
  const server: HttpServer = createHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, pid: process.pid + 1 }));
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  try {
    const alive = await isDaemonAlive(sampleInfo({ pid: process.pid, port }));
    assert.equal(alive, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("isDaemonAlive is true for a live pid whose /health answers ok with the matching pid", async () => {
  const server: HttpServer = createHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, pid: process.pid }));
  });
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
