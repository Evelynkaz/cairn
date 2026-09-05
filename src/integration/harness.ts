// Shared harness for the milestone-6 cross-client suite (BUILD_BRIEF §16.6,
// §13): spins up real MCP clients against the real launch paths `cairn
// setup` writes -- a stdio-launched CLI (the shim) and a direct HTTP
// connection to the daemon it starts -- so cross-client.test.ts exercises
// the same entrypoints and argv shapes a real install does.
//
// One deliberate substitution: BUILD_BRIEF §11's stdio snippet is
// `{"command":"npx","args":["-y","cairn-mem@latest"]}`, but the package is not
// published yet, so `startStdioClient` below spawns the LOCAL BUILD
// (`dist/cli/index.js`, this repo's own bin entrypoint) with `process.execPath`
// as the command instead of `npx`. Everything downstream of "a process gets
// spawned with no subcommand and a non-TTY stdin" is identical to what a
// real MCP host does -- same entrypoint, same dispatch-on-TTY logic in
// src/cli/index.ts, same shim, same ensureDaemon() auto-start. What this
// substitution does NOT prove: that `npx -y cairn-mem@latest` itself resolves
// and runs correctly from the public registry. That hop is untested here by
// necessity and must be covered by an actual `npx` smoke test once the
// package is published (BUILD_BRIEF §13's "smoke-tested on macOS/Windows/
// Linux" acceptance bar), not by this suite.

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openStore } from "../storage/index.js";
import { dbPath } from "../config/paths.js";

export interface StdioClientHandle {
  client: Client;
  transport: StdioClientTransport;
  /** The pid of the spawned CLI (shim) process, once started. */
  pid: number | null;
  close(): Promise<void>;
}

export interface HttpClientHandle {
  client: Client;
  transport: StreamableHTTPClientTransport;
  close(): Promise<void>;
}

// Resolved relative to this module's own compiled location
// (dist/integration/harness.js), never the process cwd -- see the same
// pattern in src/shim/ensure-daemon.ts.
export function cliEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "cli", "index.js");
}

// The set of every pid this harness has spawned or discovered, across every
// test in the file that imports it -- the single backstop a shared `after()`
// hook sweeps, mirroring src/shim/shim.test.ts's spawnedDaemonPids.
export const trackedPids = new Set<number>();

export function trackPid(pid: number | undefined | null): void {
  if (typeof pid === "number") {
    trackedPids.add(pid);
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Kills a spawned process by pid and waits briefly for it to actually exit,
// so a following cleanupDir() doesn't race an open file handle on Windows.
// Tolerates the pid already being gone. Same SIGKILL + one-retry shape as
// src/shim/shim.test.ts's killPid, for the same reason: a daemon spawned as
// a grandchild (test -> CLI/shim -> daemon, detached) has been observed to
// occasionally need a second forceful kill to actually die on Windows.
export async function killPid(pid: number | undefined | null): Promise<void> {
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

export async function killTrackedPids(): Promise<void> {
  for (const pid of trackedPids) {
    await killPid(pid);
  }
}

export function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // Best-effort: never mask the real failure from a test with a cleanup error.
  }
}

// StreamableHTTPClientTransport sends its requests over Node's global
// fetch(), whose keep-alive connection pool is owned by undici's global
// dispatcher -- there is no public API to close it, only this well-known
// internal symbol. Closing it is what lets this suite's own worker process
// exit on its own (CONTRIBUTING.md's "npm test must exit on its own" rule);
// it is a no-op if a future Node stops exposing the symbol.
export async function closeGlobalFetchDispatcher(): Promise<void> {
  const globalAny = globalThis as unknown as Record<symbol, { close?: () => Promise<void> } | undefined>;
  const dispatcher = globalAny[Symbol.for("undici.globalDispatcher.1")];
  await dispatcher?.close?.();
}

// Launches Cairn the way a stdio MCP client launches it: no subcommand, a
// non-TTY stdin (guaranteed by spawning through a pipe) -- see
// src/cli/index.ts's TTY dispatch and the module comment above for the
// npx substitution this makes. `name` is the client identity the daemon
// records as `source_client` (BUILD_BRIEF §9), taken from the MCP
// `clientInfo.name` this Client declares on connect.
export async function startStdioClient(name: string, home: string): Promise<StdioClientHandle> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliEntrypoint()],
    // CAIRN_EMBEDDINGS=off keeps retrieval deterministic and network-free
    // (BUILD_BRIEF §2's zero-config default already resolves to this on a
    // fresh CAIRN_HOME with no settings row -- setting it explicitly just
    // means this suite never silently starts downloading a model if a
    // future default or a stray settings row changes that).
    env: { ...process.env, CAIRN_HOME: home, CAIRN_PORT: "0", CAIRN_EMBEDDINGS: "off" },
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  const pid = transport.pid;
  trackPid(pid);
  return {
    client,
    transport,
    pid,
    async close() {
      await client.close().catch(() => {});
    },
  };
}

// Connects a real MCP client over Streamable HTTP directly to the daemon --
// the §11 HTTP snippet path, minus the setup UI, which nothing here needs.
export async function startHttpClient(name: string, url: string, token: string): Promise<HttpClientHandle> {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return {
    client,
    transport,
    async close() {
      await client.close().catch(() => {});
    },
  };
}

export async function callJson<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
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

// Per-app pause/resume (BUILD_BRIEF §9) has no MCP tool or CLI surface yet
// (only Store.setClientEnabled, used internally by the dashboard-to-be) --
// this opens a short-lived, second connection to the SAME db file the
// running daemon already has open (safe under WAL: many readers, one
// writer, busy_timeout covers the handoff) purely to flip that flag, then
// closes it immediately. It never reads or writes memory content itself.
export function setClientEnabled(home: string, clientId: string, enabled: boolean): void {
  const store = openStore({ path: dbPath(home) });
  try {
    store.setClientEnabled(clientId, enabled);
  } finally {
    store.close();
  }
}

// Same short-lived-second-connection approach as setClientEnabled above:
// list_memories (the only §6 tool that can browse deleted memories) has no
// include-deleted parameter exposed over MCP today -- only Store.list()
// supports `includeDeleted`. This is the one place this suite reaches past
// the MCP tool surface, and only to prove BUILD_BRIEF §5's "temporal
// supersede-not-delete, never a naive hard-delete" promise still holds after
// a forget() crosses client sessions; it asserts nothing a real client could
// not eventually see once that parameter is added to the tool.
export function listIncludingDeleted(home: string, options: { scope?: string; limit?: number } = {}): { id: string; deletedAt: number | null }[] {
  const store = openStore({ path: dbPath(home), readOnly: true });
  try {
    const { items } = store.list({ ...options, includeDeleted: true });
    return items.map((m) => ({ id: m.id, deletedAt: m.deletedAt }));
  } finally {
    store.close();
  }
}

// The daemon has no HTTP route for the §9 attribution view yet (it is a
// dashboard-only surface, not built in this milestone) -- this reaches the
// same store data the dashboard will, read-only, the same way
// listIncludingDeleted above does.
export function readClientStats(home: string): { sourceClient: string | null; reads: number; writes: number }[] {
  const store = openStore({ path: dbPath(home), readOnly: true });
  try {
    return store.clientStats();
  } finally {
    store.close();
  }
}

export function readAuditSourceClients(home: string): string[] {
  const store = openStore({ path: dbPath(home), readOnly: true });
  try {
    const { items } = store.auditLog({ limit: 200 });
    return items.map((e) => e.sourceClient).filter((c): c is string => c !== null);
  } finally {
    store.close();
  }
}

// Belt-and-braces snapshot of the real ~/.cairn/daemon.json, taken at import
// time (before any test using this harness has run), so a test file can
// assert the real one was never touched -- same reasoning and same
// can-never-false-fail shape as src/shim/shim.test.ts's own version.
const realDaemonJsonPath = join(homedir(), ".cairn", "daemon.json");
const realDaemonJsonMtimeBefore = existsSync(realDaemonJsonPath) ? statSync(realDaemonJsonPath).mtimeMs : null;

export function assertRealCairnHomeUntouched(): void {
  const mtimeAfter = existsSync(realDaemonJsonPath) ? statSync(realDaemonJsonPath).mtimeMs : null;
  if (realDaemonJsonMtimeBefore === null) {
    if (mtimeAfter !== null) {
      throw new Error("a real ~/.cairn/daemon.json appeared during this test run");
    }
    return;
  }
  if (mtimeAfter !== realDaemonJsonMtimeBefore) {
    throw new Error("the real ~/.cairn/daemon.json was modified during this test run");
  }
}

// Resolves the project root by walking up from this module's own compiled
// location until package.json (this project's own, identified by name) is
// found -- never a hardcoded relative depth, which breaks the moment
// dist/integration/ moves (CONTRIBUTING.md: tests must not bake in layout
// assumptions the code under test doesn't itself guarantee).
export function findProjectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
      if (pkg.name === "cairn-mem") {
        return dir;
      }
    }
    const parent = resolve(dir, "..");
    if (parent === dir) {
      throw new Error("could not find this project's package.json by walking up from harness.ts");
    }
    dir = parent;
  }
}
