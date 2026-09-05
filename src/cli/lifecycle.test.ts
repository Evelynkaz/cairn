// Exercises the library behind the CLI's lifecycle and embedding commands
// (BUILD_BRIEF §11, §16.5) end-to-end against a real, separately-spawned
// daemon process where relevant, and against isolated temp homes
// everywhere else -- no test here may touch the developer's real ~/.cairn,
// and every process this file spawns is killed in a `finally`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { join } from "node:path";
import { withTempDir, withTempDirAsync } from "../testing/tmp.js";
import { ensureDaemon } from "../shim/ensure-daemon.js";
import { generateToken, readRuntimeFile, writeRuntimeFile } from "../daemon/runtime-file.js";
import { dbPath } from "../config/paths.js";
import { openDb } from "../storage/db.js";
import { resolveEmbeddingConfig } from "../embeddings/registry.js";
import {
  daemonStatus,
  disableEmbeddings,
  embeddingStatus,
  enableEmbeddings,
  stopDaemon,
  uiUrl,
} from "./lifecycle.js";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Backstop kill for a process this file spawned, used both as the ordinary
// cleanup and as a safety net after stopDaemon already claims success --
// tolerates the pid already being gone (SIGKILL on a dead pid is a no-op).
async function killPid(pid: number | undefined | null): Promise<void> {
  if (pid === undefined || pid === null || !isPidAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  const deadline = Date.now() + 2000;
  while (isPidAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Spawns a real daemon (via ensureDaemon, the same auto-start the shim
// uses) against a fresh temp home, so daemonStatus/stopDaemon exercise a
// genuine separate process rather than signalling the test runner itself.
async function withRealDaemon<T>(
  dir: string,
  fn: (info: { pid: number; url: string; port: number }) => Promise<T>,
): Promise<T> {
  const result = await ensureDaemon({ home: dir, env: { ...process.env, CAIRN_PORT: "0" } });
  const pid = result.spawnedPid;
  assert.ok(typeof pid === "number", "ensureDaemon must have spawned a daemon for a fresh temp home");
  try {
    return await fn({ pid, url: result.url, port: Number(new URL(result.url).port) });
  } finally {
    await killPid(pid);
  }
}

test("daemonStatus reports not running when no runtime file exists", async () => {
  await withTempDirAsync(async (dir) => {
    const status = await daemonStatus(dir);
    assert.equal(status.running, false);
    assert.equal(status.staleRuntimeFile, undefined);
  });
});

test("daemonStatus reports a stale runtime file naming a dead daemon, without throwing", async () => {
  await withTempDirAsync(async (dir) => {
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = child.pid;
    assert.ok(typeof deadPid === "number" && deadPid > 0);
    writeRuntimeFile(
      { pid: deadPid, port: 65535, token: generateToken(), startedAt: Date.now(), version: "0.1.0" },
      dir,
    );

    const status = await daemonStatus(dir);
    assert.equal(status.running, false);
    assert.equal(status.staleRuntimeFile, true);
  });
});

test("daemonStatus reflects a real running daemon, and stopDaemon stops it", async () => {
  await withTempDirAsync(async (dir) => {
    await withRealDaemon(dir, async ({ pid }) => {
      const status = await daemonStatus(dir);
      assert.equal(status.running, true);
      assert.equal(status.pid, pid);
      assert.equal(typeof status.port, "number");
      assert.equal(typeof status.memories, "number");
      assert.equal(typeof status.vectors, "boolean");

      const stopResult = await stopDaemon({ home: dir, timeoutMs: 8_000 });
      assert.equal(stopResult.stopped, true);
      assert.equal(stopResult.pid, pid);

      const afterStatus = await daemonStatus(dir);
      assert.equal(afterStatus.running, false);
      assert.ok(!existsSync(join(dir, "daemon.json")));
    });
  });
});

test("stopDaemon never signals a bystander process that merely occupies the recorded pid/port", async () => {
  await withTempDirAsync(async (dir) => {
    // The victim: an ordinary long-lived node process, standing in for
    // whatever the OS happened to recycle the recorded pid to.
    const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    const victimPid = await new Promise<number>((resolve, reject) => {
      victim.once("spawn", () => resolve(victim.pid as number));
      victim.once("error", reject);
    });

    // A foreign HTTP server on the recorded port, answering /health with a
    // shape that resembles a health check but never the cairn daemon's own
    // pid -- exactly the "unrelated local service took the port" scenario.
    const foreign: HttpServer = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: victimPid + 1 }));
    });
    const foreignPort = await new Promise<number>((resolve) => {
      foreign.listen(0, "127.0.0.1", () => {
        const address = foreign.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });

    try {
      writeRuntimeFile(
        { pid: victimPid, port: foreignPort, token: generateToken(), startedAt: Date.now(), version: "0.1.0" },
        dir,
      );

      assert.equal(isPidAlive(victimPid), true, "victim must be alive before stopDaemon runs");

      const result = await stopDaemon({ home: dir, timeoutMs: 1500 });
      assert.equal(result.stopped, false);
      assert.match(result.detail ?? "", /not the cairn daemon/);

      assert.equal(isPidAlive(victimPid), true, "the bystander must survive stopDaemon");
      assert.ok(!existsSync(join(dir, "daemon.json")), "the stale runtime file must be removed");
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
      await killPid(victimPid);
    }
  });
});

test("stopDaemon with no daemon running reports stopped:false with a detail, and does not throw", async () => {
  await withTempDirAsync(async (dir) => {
    const result = await stopDaemon({ home: dir, timeoutMs: 200 });
    assert.equal(result.stopped, false);
    assert.ok(typeof result.detail === "string" && result.detail.length > 0);
  });
});

// A fake daemon good enough to satisfy isDaemonAlive's identity check
// (matching pid on /health), without spawning a real cairn process --
// used to control exactly what the runtime file's token is, which
// withRealDaemon (a genuine spawned daemon) does not let a test do.
async function withFakeLiveDaemon<T>(
  dir: string,
  token: string,
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const server: HttpServer = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        pid: process.pid,
        version: "0.1.0",
        uptimeMs: 0,
        memories: 0,
        vectors: false,
        journalMode: null,
      }),
    );
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  writeRuntimeFile({ pid: process.pid, port, token, startedAt: Date.now(), version: "0.1.0" }, dir);
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("uiUrl is null with no daemon and carries the daemon's token in the fragment with one", async () => {
  await withTempDirAsync(async (dir) => {
    assert.equal(await uiUrl(dir), null);
    const token = generateToken();
    await withFakeLiveDaemon(dir, token, async (url) => {
      assert.equal(await uiUrl(dir), `${url}/ui#token=${token}`);
    });
  });
});

test("uiUrl percent-encodes a token with fragment-special characters, and decodes back exactly", async () => {
  await withTempDirAsync(async (dir) => {
    const token = "abc#def&ghi jkl";
    await withFakeLiveDaemon(dir, token, async (url) => {
      const result = await uiUrl(dir);
      assert.equal(result, `${url}/ui#token=${encodeURIComponent(token)}`);
      const fragment = (result as string).split("#token=")[1] ?? "";
      assert.equal(decodeURIComponent(fragment), token);
    });
  });
});

test("uiUrl against a real spawned daemon carries that daemon's real token", async () => {
  await withTempDirAsync(async (dir) => {
    await withRealDaemon(dir, async ({ url }) => {
      const info = readRuntimeFile(dir);
      assert.ok(info && info.token.length > 0);
      assert.equal(await uiUrl(dir), `${url}/ui#token=${encodeURIComponent((info as { token: string }).token)}`);
    });
  });
});

test("uiUrl falls back to the plain /ui URL when the runtime file has no usable token", async () => {
  await withTempDirAsync(async (dir) => {
    await withFakeLiveDaemon(dir, "", async (url) => {
      assert.equal(await uiUrl(dir), `${url}/ui`);
    });
  });
});

test("embeddingStatus on a fresh store is off, not consented, unavailable with a reason", async () => {
  await withTempDirAsync(async (dir) => {
    const status = embeddingStatus(dir);
    assert.equal(status.provider, "off");
    assert.equal(status.consented, false);
    assert.equal(status.available, false);
    assert.ok(typeof status.reason === "string" && status.reason.length > 0);
  });
});

test("enableEmbeddings persists across a reopen and never touches the network or downloads a model", async () => {
  await withTempDirAsync(async (dir) => {
    const status = enableEmbeddings({ home: dir });
    assert.equal(status.provider, "local-onnx");
    assert.equal(status.consented, true);
    // The runtime is an optional peer dependency, not installed in this
    // environment -- exactly the common post-consent case the reason must
    // name, per BUILD_BRIEF §2 (a config command must never itself download
    // a model).
    assert.equal(status.available, false);
    // Non-circular: the reason after enableEmbeddings just recorded consent
    // must name the actual install step, not tell the user to re-run the
    // command they just ran.
    assert.ok(status.reason !== null && /Consent recorded/.test(status.reason));
    assert.ok(status.reason !== null && /npm install --prefix/.test(status.reason));
    assert.ok(status.reason !== null && !/cairn embeddings enable/.test(status.reason));

    // Persisted, not just returned: re-reading via a fresh db handle sees
    // the same consent.
    const db = openDb({ path: dbPath(dir) });
    try {
      const config = resolveEmbeddingConfig(db);
      assert.equal(config.provider, "local-onnx");
      assert.equal(config.consented, true);
    } finally {
      db.close();
    }

    // No model download as a side effect of consenting.
    assert.ok(!existsSync(join(dir, "models")));
  });
});

test("enableEmbeddings rejects an unknown provider name and leaves previous settings untouched", async () => {
  await withTempDirAsync(async (dir) => {
    const before = enableEmbeddings({ home: dir, provider: "local-onnx" });
    assert.equal(before.provider, "local-onnx");
    assert.equal(before.consented, true);

    assert.throws(() => enableEmbeddings({ home: dir, provider: "onnx" }), /onnx/);

    const db = openDb({ path: dbPath(dir) });
    try {
      const config = resolveEmbeddingConfig(db);
      assert.equal(config.provider, "local-onnx");
      assert.equal(config.consented, true);
    } finally {
      db.close();
    }
  });
});

test("disableEmbeddings returns the config to off", async () => {
  await withTempDirAsync(async (dir) => {
    enableEmbeddings({ home: dir });
    const status = disableEmbeddings(dir);
    assert.equal(status.provider, "off");
    assert.equal(status.consented, false);
  });
});

// --- testing/tmp.ts's own helpers ---

test("withTempDir creates and cleans up a directory around a sync callback", () => {
  let seenDir = "";
  withTempDir((dir) => {
    seenDir = dir;
    assert.ok(existsSync(dir));
  });
  assert.ok(!existsSync(seenDir));
});

test("withTempDir throws loudly instead of racing when fn returns a thenable", () => {
  let seenDir = "";
  assert.throws(
    () =>
      withTempDir((dir) => {
        seenDir = dir;
        return Promise.resolve(1);
      }),
    /withTempDirAsync/,
  );
  // Still cleaned up on the way out, same as any other synchronous throw.
  assert.ok(!existsSync(seenDir));
});

test("withTempDirAsync does not clean up the directory until the callback settles", async () => {
  let releaseCallback: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    releaseCallback = resolve;
  });
  let seenDir = "";
  const running = withTempDirAsync(async (dir) => {
    seenDir = dir;
    await blocked;
    return 1;
  });

  // The callback has not settled yet -- the directory must still be there.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(existsSync(seenDir));

  releaseCallback?.();
  const result = await running;
  assert.equal(result, 1);
  assert.ok(!existsSync(seenDir));
});
