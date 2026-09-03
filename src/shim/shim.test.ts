// End-to-end proof for the stdio->HTTP shim and its daemon auto-start
// (BUILD_BRIEF §4, §11): every test here uses a temp CAIRN_HOME and
// port: 0 (via CAIRN_PORT), and kills every process it spawns in a
// `finally` -- a leaked daemon would poison later tests.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { closeSync, existsSync, openSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isJSONRPCRequest, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { makeTempDir } from "../testing/tmp.js";
import { ensureDaemon } from "./ensure-daemon.js";
import { runShim } from "./index.js";
import type { EnsureDaemonResult } from "./ensure-daemon.js";
import { readRuntimeFile, writeRuntimeFile } from "../daemon/runtime-file.js";

interface RememberResult {
  id: string;
  deduped: boolean;
  episodeId: string;
}

interface RecallHit {
  id: string;
  text: string;
}

interface RecallResult {
  hits: RecallHit[];
}

// Captured before any test below runs (module top-level, synchronous), so
// the belt-and-braces assertion at the end of this file has a true "before"
// state to compare against -- see that test for why this can never produce
// a false failure on a developer's own machine.
const realDaemonJsonPath = join(homedir(), ".cairn", "daemon.json");
const realDaemonJsonMtimeBefore = existsSync(realDaemonJsonPath) ? statSync(realDaemonJsonPath).mtimeMs : null;

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // Best-effort: never mask the real failure from a test with a cleanup error.
  }
}

// StreamableHTTPClientTransport sends its requests over Node's global
// fetch(), whose keep-alive connection pool is owned by undici's global
// dispatcher -- there is no public API to close it, only this well-known
// internal symbol. Closing it is what lets this file's own worker process
// exit on its own (see CONTRIBUTING.md); it is a no-op if a future Node
// stops exposing the symbol, rather than a hard failure.
async function closeGlobalFetchDispatcher(): Promise<void> {
  const globalAny = globalThis as unknown as Record<symbol, { close?: () => Promise<void> } | undefined>;
  const dispatcher = globalAny[Symbol.for("undici.globalDispatcher.1")];
  await dispatcher?.close?.();
}

after(async () => {
  for (const pid of spawnedDaemonPids) {
    await killPid(pid);
  }
  await closeGlobalFetchDispatcher();
});

// Backstop for every daemon this file spawns (BUILD_BRIEF's own tests are
// the only thing that ever spawns a *real* `dist/daemon/main.js` process --
// see CONTRIBUTING.md on why `npm test` must exit on its own). Each test
// already kills the daemon(s) it knows about in its own `finally`, but
// ensureDaemon() can spawn a child that never ends up owning daemon.json: two
// racing calls can both bind and both start, and whichever writes
// daemon.json last leaves the other alive with nothing pointing at it (see
// the race comment in ensure-daemon.ts). Every pid recorded here was
// discovered via a call this file itself made against a temp CAIRN_HOME --
// never the real one -- so re-killing them all after every test has run is
// always safe, and a pid already dead (because its own test's `finally`
// already killed it) is a no-op for killPid().
const spawnedDaemonPids = new Set<number>();

function trackPid(pid: number | undefined | null): void {
  if (typeof pid === "number") {
    spawnedDaemonPids.add(pid);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Kills a spawned process (shim or daemon) by pid and waits briefly for it
// to actually exit, so a following cleanupDir() doesn't race an open file
// handle on Windows. Tolerates the pid already being gone. Uses SIGKILL
// (not the default SIGTERM) and retries once if the process is still
// reporting alive after the first poll window -- a daemon spawned as a
// grandchild (test -> shim -> daemon, all detached) has been observed to
// occasionally need a second forceful kill to actually die on Windows, and
// a leftover one keeps a port and an open temp database that poisons later
// runs and can keep the whole test file from exiting on its own.
async function killPid(pid: number | undefined | null): Promise<void> {
  if (pid === undefined || pid === null) {
    return;
  }
  for (let attempt = 0; attempt < 2 && isPidAlive(pid); attempt++) {
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
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function shimEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "index.js");
}

function daemonMainEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "daemon", "main.js");
}

function spawnShim(env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [shimEntrypoint()], { stdio: ["pipe", "pipe", "pipe"], env });
}

// Proves the entrypoint guards in src/shim/index.ts and src/daemon/main.ts
// (BUILD_BRIEF §2, §10): importing either BUILT module must never spawn a
// daemon or touch CAIRN_HOME as a side effect -- only running it directly as
// a program may. Runs the import in a fresh child process, pointed at a
// throwaway CAIRN_HOME (never the real one), so this stays honest even if a
// guard is broken and a real daemon starts. If the guard is missing, `main()`
// runs unconditionally and starts spawning the daemon (or binding the port)
// synchronously as part of module evaluation, well before the child's
// `import()` promise settles -- so a short wait after the child exits is
// enough to let a same-tick-spawned daemon finish writing its files.
async function assertImportHasNoSideEffects(entrypointPath: string): Promise<void> {
  const home = makeTempDir();
  const importUrl = pathToFileURL(entrypointPath).href;
  const env = { ...process.env, CAIRN_HOME: home, CAIRN_PORT: "0", CAIRN_TEST_IMPORT_URL: importUrl };
  const script = [
    "const url = process.env.CAIRN_TEST_IMPORT_URL;",
    'import(url).then(() => process.exit(0)).catch((err) => {',
    '  process.stderr.write(String(err && err.stack ? err.stack : err) + "\\n");',
    "  process.exit(1);",
    "});",
  ].join("\n");
  let child: ChildProcess | undefined;
  let stderr = "";
  try {
    child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe"], env });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const exited = new Promise<number | null>((resolve) => {
      child?.once("exit", (code) => resolve(code));
    });
    const outcome = await Promise.race([
      exited,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3_000)),
    ]);
    if (outcome === "timeout") {
      assert.fail(
        `importing ${entrypointPath} did not let the child process exit on its own within 3s -- the entrypoint guard may be missing`,
      );
    } else {
      assert.equal(outcome, 0, `importing ${entrypointPath} exited non-zero: ${stderr}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(
      readRuntimeFile(home),
      null,
      `importing ${entrypointPath} must not spawn a daemon (found daemon.json in a temp CAIRN_HOME)`,
    );
    assert.equal(
      existsSync(join(home, "cairn.db")),
      false,
      `importing ${entrypointPath} must not create the database file`,
    );
  } finally {
    await killPid(readRuntimeFile(home)?.pid);
    await killPid(child?.pid);
    cleanupDir(home);
  }
}

test("importing the built shim module does not spawn a daemon or touch CAIRN_HOME", async () => {
  await assertImportHasNoSideEffects(shimEntrypoint());
});

test("importing the built daemon module does not start a daemon or touch CAIRN_HOME", async () => {
  await assertImportHasNoSideEffects(daemonMainEntrypoint());
});

// A minimal Transport (not the SDK's StdioClientTransport, which spawns its
// own child process) that talks to an already-spawned shim child over its
// stdin/stdout, and hands every raw line it sees on stdout to `onRawLine` --
// this is what lets a test assert that nothing but MCP protocol ever
// reaches the shim's stdout.
class ChildStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private buffer = "";
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly onRawLine: (line: string) => void;

  constructor(child: ChildProcessWithoutNullStreams, onRawLine: (line: string) => void) {
    this.child = child;
    this.onRawLine = onRawLine;
  }

  async start(): Promise<void> {
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let index = this.buffer.indexOf("\n");
      while (index !== -1) {
        const line = this.buffer.slice(0, index).replace(/\r$/, "");
        this.buffer = this.buffer.slice(index + 1);
        this.onRawLine(line);
        if (line.trim() !== "") {
          try {
            this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
          } catch (err) {
            this.onerror?.(err instanceof Error ? err : new Error(String(err)));
          }
        }
        index = this.buffer.indexOf("\n");
      }
    });
    this.child.once("close", () => this.onclose?.());
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    // Destroy the read ends explicitly rather than waiting for the child's
    // own pipe close to propagate: a forcefully killed child (killPid uses
    // SIGKILL) does not always signal EOF on these pipes promptly, and a
    // lingering, un-destroyed stdout/stderr Socket in this (parent) process
    // has been observed to keep the whole test file's process alive well
    // past every test finishing.
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
}

function assertLineIsProtocolOrEmpty(line: string): void {
  if (line.trim() === "") {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    assert.fail(`shim wrote a non-JSON line to stdout: ${line}`);
    return;
  }
  const result = JSONRPCMessageSchema.safeParse(parsed);
  assert.ok(result.success, `shim wrote a line to stdout that is not a valid MCP message: ${line}`);
}

async function callJson<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (!("content" in result) || !Array.isArray(result.content)) {
    throw new Error(`tool ${name} returned no content array`);
  }
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error(`tool ${name} returned no text content`);
  }
  if (result.isError === true) {
    throw new Error(`tool ${name} returned an error: ${first.text}`);
  }
  return JSON.parse(first.text) as T;
}

function connectHttp(url: string, token: string, name: string): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  return { client: new Client({ name, version: "1.0.0" }), transport };
}

test("ensureDaemon starts a daemon when none is running, and a second call finds the same one", async () => {
  const home = makeTempDir();
  const env = { ...process.env, CAIRN_PORT: "0" };
  let daemonPid: number | undefined;
  try {
    const first = await ensureDaemon({ home, env, timeoutMs: 15_000 });
    trackPid(first.spawnedPid);
    assert.equal(first.started, true);
    assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(first.token.length > 0);

    const info = readRuntimeFile(home);
    assert.ok(info);
    daemonPid = info?.pid;
    trackPid(daemonPid);

    const second = await ensureDaemon({ home, env, timeoutMs: 15_000 });
    trackPid(second.spawnedPid);
    assert.equal(second.started, false);
    assert.equal(second.url, first.url);
    assert.equal(second.token, first.token);
  } finally {
    await killPid(daemonPid ?? readRuntimeFile(home)?.pid);
    cleanupDir(home);
  }
});

test("ensureDaemon ignores a stale runtime file naming a dead pid and starts a fresh daemon", async () => {
  const home = makeTempDir();
  const env = { ...process.env, CAIRN_PORT: "0" };
  let daemonPid: number | undefined;
  try {
    const deadChild = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = deadChild.pid;
    assert.ok(typeof deadPid === "number" && deadPid > 0, "child process must have reported a pid");
    writeRuntimeFile({ pid: deadPid as number, port: 59999, token: "stale-token", startedAt: Date.now(), version: "0.1.0" }, home);

    const result = await ensureDaemon({ home, env, timeoutMs: 15_000 });
    trackPid(result.spawnedPid);
    assert.equal(result.started, true);
    assert.notEqual(result.token, "stale-token");

    const info = readRuntimeFile(home);
    assert.ok(info);
    assert.notEqual(info?.pid, deadPid);
    daemonPid = info?.pid;
    trackPid(daemonPid);
  } finally {
    await killPid(daemonPid ?? readRuntimeFile(home)?.pid);
    cleanupDir(home);
  }
});

test("two concurrent ensureDaemon calls racing to spawn on the same port both resolve to the one winner", async () => {
  const home = makeTempDir();
  const port = await freePort();
  const env = { ...process.env, CAIRN_PORT: String(port) };
  let daemonPid: number | undefined;
  let aPid: number | undefined;
  let bPid: number | undefined;
  try {
    // On the fixed port both calls share, only one spawned child can ever
    // actually bind it -- the loser is expected to hit EADDRINUSE in its own
    // process and exit unaided (see the comment in ensure-daemon.ts).
    // Tracking BOTH spawned pids here, not just the eventual owner's, is
    // what catches it if that assumption ever doesn't hold: a loser that
    // somehow stays alive would otherwise be referenced by nobody once this
    // test returns.
    const [a, b] = await Promise.all([
      ensureDaemon({ home, env, timeoutMs: 15_000 }),
      ensureDaemon({ home, env, timeoutMs: 15_000 }),
    ]);
    aPid = a.spawnedPid;
    bPid = b.spawnedPid;
    trackPid(aPid);
    trackPid(bPid);
    assert.equal(a.url, `http://127.0.0.1:${port}`);
    assert.equal(a.url, b.url);
    assert.equal(a.token, b.token);

    const info = readRuntimeFile(home);
    assert.ok(info);
    daemonPid = info?.pid;
    trackPid(daemonPid);
  } finally {
    await killPid(daemonPid ?? readRuntimeFile(home)?.pid);
    await killPid(aPid);
    await killPid(bPid);
    cleanupDir(home);
  }
});

test("ensureDaemon does not leak the daemon.log file descriptor across repeated spawns", async () => {
  const iterations = 3;
  const homes: string[] = [];
  const pids: (number | undefined)[] = [];
  const probeFds: number[] = [];
  try {
    for (let i = 0; i < iterations; i++) {
      const home = makeTempDir();
      homes.push(home);
      const env = { ...process.env, CAIRN_PORT: "0" };
      const result = await ensureDaemon({ home, env, timeoutMs: 15_000 });
      trackPid(result.spawnedPid);
      assert.equal(result.started, true);
      pids.push(readRuntimeFile(home)?.pid);

      // Probe: open and immediately close a throwaway fd. If ensureDaemon
      // leaked the daemon.log fd it opened for the spawned child, this
      // probe's fd number climbs by roughly one per prior ensureDaemon
      // call, since those never-closed fds are still holding slots.
      const probeFd = openSync(join(home, "probe"), "w");
      probeFds.push(probeFd);
      closeSync(probeFd);
    }
    for (let i = 1; i < probeFds.length; i++) {
      assert.ok(
        (probeFds[i] ?? 0) - (probeFds[0] ?? 0) <= 1,
        `probe fd numbers grew across ensureDaemon calls (${probeFds.join(", ")}), suggesting a descriptor leak`,
      );
    }
  } finally {
    for (let i = 0; i < homes.length; i++) {
      await killPid(pids[i] ?? readRuntimeFile(homes[i] as string)?.pid);
    }
    for (const home of homes) {
      cleanupDir(home);
    }
  }
});

test("ensureDaemon kills the spawned child instead of orphaning it when it never becomes healthy", async () => {
  const home = makeTempDir();
  const env = { ...process.env, CAIRN_PORT: "0" };
  try {
    await assert.rejects(() => ensureDaemon({ home, env, timeoutMs: 1 }));

    // ensureDaemon gave up almost immediately (timeoutMs: 1), well before a
    // real daemon can finish starting and write its runtime file -- unless
    // the process it spawned was left running regardless. Give that
    // process ample time to finish starting on its own if it was NOT
    // killed, then confirm no runtime file (and so no live daemon) ever
    // shows up: that is the best portable proxy for "no orphaned child"
    // without a handle on the spawned child's own pid.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const info = readRuntimeFile(home);
    assert.equal(info, null, "a daemon wrote its runtime file after the ensureDaemon caller had already timed out and killed it");
  } finally {
    await killPid(readRuntimeFile(home)?.pid);
    cleanupDir(home);
  }
});

test("a real MCP client through the shim (stdio) and a real MCP client direct to the daemon (HTTP) share one store, in both directions", async () => {
  const home = makeTempDir();
  const env = { ...process.env, CAIRN_HOME: home, CAIRN_PORT: "0" };
  const rawLines: string[] = [];
  const shimChild = spawnShim(env);
  const stdioClient = new Client({ name: "shim-test-client", version: "1.0.0" });
  let httpClient: Client | undefined;
  let daemonPid: number | undefined;

  try {
    const transport = new ChildStdioTransport(shimChild, (line) => rawLines.push(line));
    await stdioClient.connect(transport);

    const rememberedOverStdio = await callJson<RememberResult>(stdioClient, "remember", {
      content: "Cross-client shim proof: told via stdio.",
    });
    assert.ok(rememberedOverStdio.id);

    const info = readRuntimeFile(home);
    assert.ok(info, "the shim must have auto-started a daemon and written its runtime file");
    daemonPid = info?.pid;
    trackPid(daemonPid);
    const url = `http://127.0.0.1:${info?.port}`;
    const token = info?.token ?? "";

    const direct = connectHttp(url, token, "direct-http-client");
    httpClient = direct.client;
    await httpClient.connect(direct.transport);

    const recalledOverHttp = await callJson<RecallResult>(httpClient, "recall", { query: "told via stdio" });
    assert.ok(
      recalledOverHttp.hits.some((h) => h.id === rememberedOverStdio.id),
      "a direct HTTP client must see what was remembered through the stdio shim",
    );

    const rememberedOverHttp = await callJson<RememberResult>(httpClient, "remember", {
      content: "Cross-client shim proof: told via HTTP.",
    });
    assert.ok(rememberedOverHttp.id);

    const recalledOverStdio = await callJson<RecallResult>(stdioClient, "recall", { query: "told via HTTP" });
    assert.ok(
      recalledOverStdio.hits.some((h) => h.id === rememberedOverHttp.id),
      "the stdio client, through the shim, must see what was remembered directly over HTTP",
    );

    for (const line of rawLines) {
      assertLineIsProtocolOrEmpty(line);
    }
    assert.ok(rawLines.length > 0, "the shim must have written protocol responses to stdout");
  } finally {
    await stdioClient.close().catch(() => {});
    await httpClient?.close().catch(() => {});
    await killPid(shimChild.pid);
    await killPid(daemonPid ?? readRuntimeFile(home)?.pid);
    cleanupDir(home);
  }
});

test("killing the shim process leaves the daemon running and still serving over HTTP", async () => {
  const home = makeTempDir();
  const env = { ...process.env, CAIRN_HOME: home, CAIRN_PORT: "0" };
  const shimChild = spawnShim(env);
  const stdioClient = new Client({ name: "kill-shim-test-client", version: "1.0.0" });
  let daemonPid: number | undefined;

  try {
    const transport = new ChildStdioTransport(shimChild, () => {});
    await stdioClient.connect(transport);

    const remembered = await callJson<RememberResult>(stdioClient, "remember", {
      content: "Survives the shim being killed.",
    });
    assert.ok(remembered.id);

    const info = readRuntimeFile(home);
    assert.ok(info);
    daemonPid = info?.pid;
    trackPid(daemonPid);
    const url = `http://127.0.0.1:${info?.port}`;
    const token = info?.token ?? "";

    shimChild.kill();
    await new Promise((resolve) => shimChild.once("close", resolve));

    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);

    const direct = connectHttp(url, token, "post-kill-check");
    await direct.client.connect(direct.transport);
    try {
      const recalled = await callJson<RecallResult>(direct.client, "recall", { query: "survives the shim" });
      assert.ok(recalled.hits.some((h) => h.id === remembered.id));
    } finally {
      await direct.client.close();
    }
  } finally {
    await stdioClient.close().catch(() => {});
    await killPid(shimChild.pid);
    await killPid(daemonPid ?? readRuntimeFile(home)?.pid);
    cleanupDir(home);
  }
});

test("closing the shim's stdin, as an MCP client disconnecting would, makes the shim process exit on its own", async () => {
  // node --test --test-force-exit hides event-loop residue left over in the
  // TEST process by pooled client-side keep-alive sockets (see
  // CONTRIBUTING.md); it says nothing about the shim binary a real MCP host
  // runs. This proves the shim process itself still exits unaided -- via its
  // own stdin "end" handler in src/shim/index.ts -- when the host closes the
  // connection the way a real MCP client would, so nothing here relies on
  // that flag.
  const home = makeTempDir();
  const env = { ...process.env, CAIRN_HOME: home, CAIRN_PORT: "0" };
  const shimChild = spawnShim(env);
  const stdioClient = new Client({ name: "stdin-close-test-client", version: "1.0.0" });
  let daemonPid: number | undefined;

  try {
    const transport = new ChildStdioTransport(shimChild, () => {});
    await stdioClient.connect(transport);

    const remembered = await callJson<RememberResult>(stdioClient, "remember", {
      content: "Shim must exit when stdin closes.",
    });
    assert.ok(remembered.id);

    const info = readRuntimeFile(home);
    assert.ok(info);
    daemonPid = info?.pid;
    trackPid(daemonPid);

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      shimChild.once("exit", (code, signal) => resolve({ code, signal }));
    });

    shimChild.stdin.end();

    const outcome = await Promise.race([
      exited,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
    ]);

    if (outcome === "timeout") {
      assert.fail("the shim process must exit on its own within 5s of stdin closing, not require being killed");
    } else {
      assert.equal(outcome.code, 0, "the shim must exit cleanly (code 0) when stdin closes");
    }

    assert.ok(daemonPid !== undefined && isPidAlive(daemonPid), "the daemon must still be running after the shim exits");
  } finally {
    await stdioClient.close().catch(() => {});
    await killPid(shimChild.pid);
    await killPid(daemonPid ?? readRuntimeFile(home)?.pid);
    cleanupDir(home);
  }
});

test("after the daemon dies mid-session, the shim recovers by reconnecting or exits so the host can respawn it", async () => {
  const home = makeTempDir();
  const env = { ...process.env, CAIRN_HOME: home, CAIRN_PORT: "0" };
  const shimChild = spawnShim(env);
  const stdioClient = new Client({ name: "daemon-death-test-client", version: "1.0.0" });
  let daemonPid: number | undefined;
  let shimExited = false;
  shimChild.once("exit", () => {
    shimExited = true;
  });

  try {
    const transport = new ChildStdioTransport(shimChild, () => {});
    await stdioClient.connect(transport);

    const remembered = await callJson<RememberResult>(stdioClient, "remember", {
      content: "Before the daemon dies.",
    });
    assert.ok(remembered.id);

    const info = readRuntimeFile(home);
    assert.ok(info);
    daemonPid = info?.pid;
    trackPid(daemonPid);
    await killPid(daemonPid);
    daemonPid = undefined;

    const deadline = Date.now() + 20_000;
    let recovered = false;
    let rememberedAfter: RememberResult | undefined;
    while (Date.now() < deadline && !shimExited) {
      try {
        rememberedAfter = await callJson<RememberResult>(stdioClient, "remember", {
          content: "After the daemon died and the shim reconnected.",
        });
        recovered = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    if (shimExited) {
      assert.ok(true, "the shim exited so the MCP host can respawn it");
    } else {
      assert.ok(recovered, "the shim must eventually serve a call again after the daemon died: reconnect, or exit for a respawn");
      assert.ok(rememberedAfter?.id);
      daemonPid = readRuntimeFile(home)?.pid;
      trackPid(daemonPid);
    }
  } finally {
    await stdioClient.close().catch(() => {});
    await killPid(shimChild.pid);
    await killPid(daemonPid ?? readRuntimeFile(home)?.pid);
    cleanupDir(home);
  }
});

function makeRecordingTransport(): { transport: Transport; sent: JSONRPCMessage[] } {
  const sent: JSONRPCMessage[] = [];
  const transport: Transport = {
    start: async () => {},
    close: async () => {},
    send: async (message) => {
      sent.push(message);
    },
  };
  return { transport, sent };
}

function idsOf(messages: JSONRPCMessage[]): unknown[] {
  return messages.filter((m) => "id" in m).map((m) => (m as { id: unknown }).id);
}

test("a single failed forward to the daemon fails only that request, leaving the other's real response intact", async () => {
  const { transport: stdioTransport, sent: stdioSent } = makeRecordingTransport();

  const fakeDaemon: EnsureDaemonResult = { url: "http://127.0.0.1:1", token: "test-token", started: true };
  let httpTransport: Transport | undefined;

  await runShim({
    stdioTransport,
    ensureDaemon: async () => fakeDaemon,
    makeHttpTransport: () => {
      const transport: Transport = {
        start: async () => {},
        close: async () => {},
        send: async (message) => {
          if ("id" in message && message.id === "fails") {
            throw new Error("simulated POST failure");
          }
          if ("id" in message && message.id === "ok") {
            queueMicrotask(() => {
              transport.onmessage?.({ jsonrpc: "2.0", id: "ok", result: {} });
            });
          }
        },
      };
      httpTransport = transport;
      return transport;
    },
    stdin: { on: () => {} },
  });

  stdioTransport.onmessage?.({ jsonrpc: "2.0", id: "fails", method: "tools/call", params: {} });
  stdioTransport.onmessage?.({ jsonrpc: "2.0", id: "ok", method: "tools/call", params: {} });

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(httpTransport, "makeHttpTransport must have been called");
  assert.deepEqual(idsOf(stdioSent).sort(), ["fails", "ok"]);
  assert.equal(idsOf(stdioSent).filter((id) => id === "fails").length, 1, "the failed request must get exactly one response");
  assert.equal(idsOf(stdioSent).filter((id) => id === "ok").length, 1, "the still-in-flight request must get exactly one response");

  const failedResponse = stdioSent.find((m) => "id" in m && (m as { id: unknown }).id === "fails");
  assert.ok(failedResponse && "error" in failedResponse, "the failed request's one response must be an error");
});

// The two tests below exercise the daemon-death reconnect path directly at
// the shim level with fake transports, independent of a real daemon/MCP
// server -- the same behaviour is also proven end-to-end by the
// "after the daemon dies mid-session..." integration test above, but that
// one depends on a real `remember` round trip through the daemon.

test("when the daemon connection closes unexpectedly, the shim reconnects via a fresh ensureDaemon call and keeps serving", async () => {
  const { transport: stdioTransport, sent: stdioSent } = makeRecordingTransport();
  let ensureDaemonCalls = 0;
  const transports: Transport[] = [];

  await runShim({
    stdioTransport,
    ensureDaemon: async () => {
      ensureDaemonCalls++;
      return { url: `http://127.0.0.1:${ensureDaemonCalls}`, token: `token-${ensureDaemonCalls}`, started: true };
    },
    makeHttpTransport: () => {
      const transport: Transport = {
        start: async () => {},
        close: async () => {},
        send: async (message) => {
          if (isJSONRPCRequest(message)) {
            const { id } = message;
            queueMicrotask(() => {
              transport.onmessage?.({ jsonrpc: "2.0", id, result: {} });
            });
          }
        },
      };
      transports.push(transport);
      return transport;
    },
    stdin: { on: () => {} },
    reconnectDelaysMs: [5],
  });

  assert.equal(ensureDaemonCalls, 1);
  transports[0]?.onclose?.();

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(ensureDaemonCalls, 2, "a fresh ensureDaemon() call must happen on reconnect");
  assert.equal(transports.length, 2, "a fresh HTTP transport must be built on reconnect");

  stdioTransport.onmessage?.({ jsonrpc: "2.0", id: "after-reconnect", method: "tools/call", params: {} });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const response = stdioSent.find((m) => "id" in m && (m as { id: unknown }).id === "after-reconnect");
  assert.ok(response && "result" in response, "a request sent after reconnecting must get a real (non-error) response");
});

test("when every reconnect attempt fails, the shim exits so the MCP host can respawn it", async () => {
  const { transport: stdioTransport } = makeRecordingTransport();
  let exitCode: number | undefined;
  let ensureDaemonCalls = 0;
  let firstHttpTransport: Transport | undefined;

  await runShim({
    stdioTransport,
    ensureDaemon: async () => {
      ensureDaemonCalls++;
      if (ensureDaemonCalls === 1) {
        return { url: "http://127.0.0.1:1", token: "t", started: true };
      }
      throw new Error("daemon will not come back");
    },
    makeHttpTransport: () => {
      const transport: Transport = {
        start: async () => {},
        close: async () => {},
        send: async () => {},
      };
      firstHttpTransport ??= transport;
      return transport;
    },
    stdin: { on: () => {} },
    exit: (code) => {
      exitCode = code;
    },
    reconnectDelaysMs: [1, 1],
  });

  firstHttpTransport?.onclose?.();
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(exitCode, 1, "the shim must exit non-zero once every reconnect attempt is exhausted");
  assert.ok(ensureDaemonCalls >= 3, "ensureDaemon must have been retried for each backoff attempt");
});

// Belt-and-braces, on top of every test above using a temp CAIRN_HOME: this
// checks the REAL ~/.cairn (via the real os.homedir(), not any override)
// was not touched by this run. It must never assert the real ~/.cairn is
// empty or absent -- a developer who actually uses Cairn locally has a real
// daemon.json there already, and that is legitimate, not a bug. So it only
// ever compares against the state recorded at module load, before any test
// in this file ran: no pre-existing file means none may appear now; a
// pre-existing file means its mtime must be unchanged. Either way this
// cannot produce a false failure on someone's real machine.
test("this test run must never write to the real ~/.cairn (every test above uses a temp CAIRN_HOME instead)", () => {
  const mtimeAfter = existsSync(realDaemonJsonPath) ? statSync(realDaemonJsonPath).mtimeMs : null;
  if (realDaemonJsonMtimeBefore === null) {
    assert.equal(mtimeAfter, null, "a real ~/.cairn/daemon.json appeared during this test run");
  } else {
    assert.equal(mtimeAfter, realDaemonJsonMtimeBefore, "the real ~/.cairn/daemon.json was modified during this test run");
  }
});
