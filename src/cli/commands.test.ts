// Exercises the CLI command layer with injected out/err and isolated temp
// homes -- no test here may touch the developer's real ~/.cairn or a real
// MCP client config file, and every process this file spawns is killed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withTempDirAsync } from "../testing/tmp.js";
import {
  resolveOsHome,
  runEmbeddingsDisable,
  runEmbeddingsStatus,
  runEmbeddingsEnable,
  runSetup,
  runStatus,
  runStop,
  helpText,
  formatDaemonStatus,
} from "./commands.js";
import type { CommandContext } from "./commands.js";
import { TOP_LEVEL_COMMANDS } from "./args.js";
import { ensureDaemon } from "../shim/ensure-daemon.js";
import { daemonStatus } from "./lifecycle.js";
import { writeRuntimeFile } from "../daemon/runtime-file.js";
import { dbPath, ensureHome } from "../config/paths.js";
import { suppressExperimentalSqliteWarning } from "./index.js";

function captureContext(overrides: Partial<CommandContext> = {}): CommandContext & { lines: { out: string[]; err: string[] } } {
  const lines = { out: [] as string[], err: [] as string[] };
  return {
    out: (line: string) => lines.out.push(line),
    err: (line: string) => lines.err.push(line),
    lines,
    ...overrides,
  };
}

test("status reports not running with no daemon", async () => {
  await withTempDirAsync(async (home) => {
    const ctx = captureContext({ home });
    const code = await runStatus(ctx, false);
    assert.equal(code, 0);
    assert.ok(ctx.lines.out.some((l) => l.includes("not running")));
  });
});

test("status --json emits valid JSON with the documented fields", async () => {
  await withTempDirAsync(async (home) => {
    const ctx = captureContext({ home });
    const code = await runStatus(ctx, true);
    assert.equal(code, 0);
    assert.equal(ctx.lines.out.length, 1);
    const parsed: unknown = JSON.parse(ctx.lines.out[0] ?? "");
    assert.ok(typeof parsed === "object" && parsed !== null);
    const body = parsed as Record<string, unknown>;
    assert.ok("daemon" in body);
    assert.ok("embeddings" in body);
    assert.ok("dbPath" in body);
    const daemon = body.daemon as Record<string, unknown>;
    assert.equal(daemon.running, false);
  });
});

test("status --json stays valid JSON, with the daemon half intact, when the database is corrupt", async () => {
  await withTempDirAsync(async (home) => {
    ensureHome(home);
    writeFileSync(dbPath(home), "this is not a sqlite file", "utf8");
    const ctx = captureContext({ home });
    const code = await runStatus(ctx, true);
    assert.equal(code, 0);
    assert.equal(ctx.lines.out.length, 1);
    const parsed = JSON.parse(ctx.lines.out[0] ?? "") as Record<string, unknown>;
    const daemon = parsed.daemon as Record<string, unknown>;
    assert.equal(daemon.running, false);
    const embeddings = parsed.embeddings as Record<string, unknown>;
    assert.equal(embeddings.available, false);
    assert.ok(typeof embeddings.reason === "string" && (embeddings.reason as string).length > 0);
  });
});

test("embeddings status --json emits {\"error\": ...} on stdout when the database is corrupt", async () => {
  await withTempDirAsync(async (home) => {
    ensureHome(home);
    writeFileSync(dbPath(home), "this is not a sqlite file", "utf8");
    const ctx = captureContext({ home });
    const code = await runEmbeddingsStatus(ctx, true);
    assert.equal(code, 1);
    assert.equal(ctx.lines.err.length, 0);
    assert.equal(ctx.lines.out.length, 1);
    const parsed = JSON.parse(ctx.lines.out[0] ?? "") as Record<string, unknown>;
    assert.ok(typeof parsed.error === "string" && parsed.error.length > 0);
  });
});

// Overrides every environment variable a client config path is resolved
// from -- not just HOME/USERPROFILE -- so an injected env can never fall
// through to the developer's real Claude Desktop config (%APPDATA% on
// Windows). This project has already had exactly that incident (see
// CONTRIBUTING.md): only the explicit `clients: [...]` filter in the tests
// below used to keep the suite off the real config; this is the isolation
// itself.
function setupEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming") };
}

test("setup --dry-run reports outcomes and writes nothing", async () => {
  await withTempDirAsync(async (home) => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const ctx = captureContext({ env: setupEnv(home) });
    const code = await runSetup(ctx, { clients: ["claude-code"], dryRun: true, print: false });
    assert.equal(code, 0);
    assert.ok(ctx.lines.out.some((l) => l.includes("Claude Code") && l.includes("created")));
    assert.ok(!existsSync(join(home, ".claude.json")));
  });
});

test("setup reports an unparsable client config loudly and leaves it untouched", async () => {
  await withTempDirAsync(async (home) => {
    const configPath = join(home, ".claude.json");
    const badContent = "{ not valid json";
    writeFileSync(configPath, badContent, "utf8");
    const ctx = captureContext({ env: setupEnv(home) });
    const code = await runSetup(ctx, { clients: ["claude-code"], dryRun: false, print: false });
    assert.equal(code, 1);
    assert.ok(ctx.lines.err.some((l) => l.includes(configPath)));
    assert.equal(readFileSync(configPath, "utf8"), badContent);
  });
});

test("setup: a failed write (read-only config) reaches stderr, exits non-zero, and does not stop the other clients", async () => {
  await withTempDirAsync(async (home) => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const claudeCodePath = join(home, ".claude.json");
    writeFileSync(claudeCodePath, JSON.stringify({ mcpServers: {} }), "utf8");
    chmodSync(claudeCodePath, 0o444);
    try {
      const ctx = captureContext({ env: setupEnv(home) });
      const code = await runSetup(ctx, { clients: ["claude-code", "cursor"], dryRun: false, print: false });
      assert.equal(code, 1);
      assert.ok(ctx.lines.err.some((l) => l.includes("FAILED") && l.includes(claudeCodePath)));
      assert.ok(ctx.lines.out.some((l) => l.includes("Cursor") && l.includes("created")));
      assert.ok(existsSync(join(home, ".cursor", "mcp.json")));
    } finally {
      chmodSync(claudeCodePath, 0o666);
    }
  });
});

test("setup: an existing different cairn entry is reported 'replaced' with a backup pointer", async () => {
  await withTempDirAsync(async (home) => {
    const configPath = join(home, ".claude.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { cairn: { command: "node", args: ["/opt/cairn/dist/cli/index.js"], env: { CAIRN_HOME: "/data/cairn" } } },
      }),
      "utf8",
    );
    const ctx = captureContext({ env: setupEnv(home) });
    const code = await runSetup(ctx, { clients: ["claude-code"], dryRun: false, print: false });
    assert.equal(code, 0);
    assert.ok(ctx.lines.out.some((l) => l.includes("replaced")));
    assert.ok(ctx.lines.out.some((l) => l.includes("overwritten") && l.includes(".cairn-backup-")));
  });
});

test("setup: an unknown --client value is reported, valid clients still configured", async () => {
  await withTempDirAsync(async (home) => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const ctx = captureContext({ env: setupEnv(home) });
    const code = await runSetup(ctx, { clients: ["claude-code", "cursr"], dryRun: true, print: false });
    assert.equal(code, 0);
    assert.ok(ctx.lines.err.some((l) => l.includes("cursr")));
    assert.ok(ctx.lines.out.some((l) => l.includes("Claude Code")));
  });
});

test("setup: an unknown --client value with no valid match is fatal", async () => {
  await withTempDirAsync(async (home) => {
    const ctx = captureContext({ env: setupEnv(home) });
    const code = await runSetup(ctx, { clients: ["cursr"], dryRun: true, print: false });
    assert.equal(code, 1);
    assert.ok(ctx.lines.err.some((l) => l.includes("cursr")));
  });
});

test("resolveOsHome: empty HOME/USERPROFILE falls back to the OS home directory", () => {
  assert.equal(resolveOsHome({}, () => "/fake/os/home"), "/fake/os/home");
  assert.equal(resolveOsHome({ HOME: "/env/home" }, () => "/fake/os/home"), "/env/home");
});

test("setup: with no resolvable home directory anywhere, refuses rather than guessing", async () => {
  const ctx = captureContext({ env: {}, homedir: () => "" });
  const code = await runSetup(ctx, { clients: [], dryRun: true, print: false });
  assert.equal(code, 1);
  assert.ok(ctx.lines.err.some((l) => l.includes("home directory")));
});

test("setup: a live, non-dry-run run against a fully isolated home configures all clients under it, nothing outside", async () => {
  await withTempDirAsync(async (home) => {
    // Mark every client as "detected" the way a real install would --
    // clientTargets looks for these markers, not the config file itself.
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(join(home, "AppData", "Roaming", "Claude"), { recursive: true });

    const ctx = captureContext({ env: setupEnv(home) });
    const code = await runSetup(ctx, { clients: [], dryRun: false, print: false });
    assert.equal(code, 0);

    const claudeCodePath = join(home, ".claude.json");
    const cursorPath = join(home, ".cursor", "mcp.json");
    const claudeDesktopPath = join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
    assert.ok(existsSync(claudeCodePath));
    assert.ok(existsSync(cursorPath));
    assert.ok(existsSync(claudeDesktopPath));
    assert.deepEqual(JSON.parse(readFileSync(claudeCodePath, "utf8")).mcpServers.cairn, {
      command: "npx",
      args: ["-y", "cairn@latest"],
    });
    assert.ok(ctx.lines.out.some((l) => l.includes("close it") || l.includes("claude mcp add")));
  });
});

test("stop: no daemon running is idempotent (exit 0)", async () => {
  await withTempDirAsync(async (home) => {
    const ctx = captureContext({ home });
    const code = await runStop(ctx);
    assert.equal(code, 0);
    assert.ok(ctx.lines.out.some((l) => l.includes("not running")) || ctx.lines.out.length > 0);
  });
});

test("stop: a live daemon whose port stays open after being signalled is reported as a failure (exit 1)", async () => {
  await withTempDirAsync(async (home) => {
    // On Windows, process.kill(pid, "SIGTERM") unconditionally terminates
    // the target process regardless of any handler it installed (there is
    // no real SIGTERM there) -- so "ignores SIGTERM" cannot be modelled by
    // a stubborn process on this platform. Model the same OBSERVABLE
    // outcome instead: the recorded port stays open past the signal, which
    // is exactly what waitUntilPortDead (lifecycle.ts) actually polls.
    // A real, ordinary child process supplies a genuine, killable pid for
    // isDaemonAlive's identity check; a separate, independent HTTP server
    // this test owns keeps the recorded port answering /health after that
    // child is gone, so stopDaemon's own port probe keeps finding it alive.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    const childPid = child.pid;
    assert.ok(childPid !== undefined);

    const server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, pid: childPid }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    writeRuntimeFile({ pid: childPid, port, token: "test-token", startedAt: Date.now(), version: "0.0.0" }, home);

    try {
      const ctx = captureContext({ home, stopTimeoutMs: 300 });
      const code = await runStop(ctx);
      assert.equal(code, 1);
      assert.ok(ctx.lines.err.some((l) => l.includes("did not stop")));
    } finally {
      child.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("embeddings enable then status shows consented and creates no models directory", async () => {
  await withTempDirAsync(async (home) => {
    const ctx = captureContext({ home });
    const enableCode = await runEmbeddingsEnable(ctx, {});
    assert.equal(enableCode, 0);

    const statusCtx = captureContext({ home });
    const statusCode = await runEmbeddingsStatus(statusCtx, true);
    assert.equal(statusCode, 0);
    const status = JSON.parse(statusCtx.lines.out[0] ?? "") as { consented: boolean; provider: string };
    assert.equal(status.consented, true);
    assert.equal(status.provider, "local-onnx");

    assert.ok(!existsSync(join(home, "models")));
    if (existsSync(home)) {
      assert.ok(!readdirSync(home).includes("models"));
    }
  });
});

test("embeddings disable returns to off", async () => {
  await withTempDirAsync(async (home) => {
    const enableCtx = captureContext({ home });
    await runEmbeddingsEnable(enableCtx, {});

    const disableCtx = captureContext({ home });
    const code = await runEmbeddingsDisable(disableCtx);
    assert.equal(code, 0);

    const statusCtx = captureContext({ home });
    await runEmbeddingsStatus(statusCtx, true);
    const status = JSON.parse(statusCtx.lines.out[0] ?? "") as { consented: boolean; provider: string };
    assert.equal(status.consented, false);
    assert.equal(status.provider, "off");
  });
});

test("formatDaemonStatus is quiet about journal mode when it is wal", () => {
  const lines = formatDaemonStatus({ running: true, pid: 1, port: 1234, url: "http://127.0.0.1:1234", journalMode: "wal" });
  assert.ok(!lines.some((l) => l.includes("journal mode")));
});

test("formatDaemonStatus surfaces a degraded (non-wal) journal mode", () => {
  const lines = formatDaemonStatus({ running: true, pid: 1, port: 1234, url: "http://127.0.0.1:1234", journalMode: "delete" });
  assert.ok(lines.some((l) => l.includes("journal mode") && l.includes("delete")));
});

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killPid(pid: number | undefined): Promise<void> {
  if (pid === undefined || !isPidAlive(pid)) {
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

test("journalMode surfaces through /health into daemonStatus (normally 'wal')", async () => {
  await withTempDirAsync(async (home) => {
    const result = await ensureDaemon({ home, env: { ...process.env, CAIRN_PORT: "0" } });
    try {
      const status = await daemonStatus(home);
      assert.equal(status.running, true);
      assert.equal(status.journalMode, "wal");
    } finally {
      await killPid(result.spawnedPid);
    }
  });
});

test("helpText lists every top-level command", () => {
  const text = helpText();
  for (const cmd of TOP_LEVEL_COMMANDS) {
    assert.ok(text.includes(cmd), `help text should mention "${cmd}"`);
  }
});

// --- end-to-end: the built bin actually works ---

function distIndexPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "index.js");
}

function runBin(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distIndexPath(), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("spawned bin: status --json exits 0 and prints parseable JSON", async () => {
  await withTempDirAsync(async (home) => {
    const env = { ...process.env, CAIRN_HOME: home };
    const result = await runBin(["status", "--json"], env);
    assert.equal(result.code, 0);
    const parsed: unknown = JSON.parse(result.stdout.trim());
    assert.ok(typeof parsed === "object" && parsed !== null);
  });
});

test("spawned bin: --help lists every command", async () => {
  const result = await runBin(["--help"], process.env);
  assert.equal(result.code, 0);
  for (const cmd of TOP_LEVEL_COMMANDS) {
    assert.ok(result.stdout.includes(cmd), `--help output should mention "${cmd}"`);
  }
});

test("spawned bin: status --json never prints Node's node:sqlite ExperimentalWarning", async () => {
  await withTempDirAsync(async (home) => {
    const env = { ...process.env, CAIRN_HOME: home };
    const result = await runBin(["status", "--json"], env);
    assert.equal(result.code, 0);
    assert.ok(!result.stderr.includes("ExperimentalWarning"), `stderr should not mention ExperimentalWarning: ${result.stderr}`);
    const parsed: unknown = JSON.parse(result.stdout.trim());
    assert.ok(typeof parsed === "object" && parsed !== null);
  });
});

// --- suppressExperimentalSqliteWarning: narrow-filter unit tests ---
//
// Runs the installer against the real process "warning" listener list, the
// same way index.ts does, rather than spawning another process: it is the
// simplest way to prove the filter matches ONLY the SQLite
// ExperimentalWarning and forwards everything else unchanged, which is the
// point of this suppression existing at all. Always restores the process's
// original listeners afterward so this file does not leak listener state
// into later tests.
test("suppressExperimentalSqliteWarning swallows only the node:sqlite ExperimentalWarning", () => {
  const originalListeners = process.listeners("warning");
  process.removeAllListeners("warning");
  const forwarded: Error[] = [];
  process.on("warning", (warning: Error) => forwarded.push(warning));
  try {
    suppressExperimentalSqliteWarning();

    const sqliteWarning = Object.assign(new Error("SQLite is an experimental feature and might change at any time"), {
      name: "ExperimentalWarning",
    });
    process.emit("warning", sqliteWarning);
    assert.deepEqual(forwarded, [], "the SQLite ExperimentalWarning must be swallowed");

    const otherWarning = Object.assign(new Error("fs.Stats constructor is deprecated"), {
      name: "DeprecationWarning",
    });
    process.emit("warning", otherWarning);
    assert.deepEqual(forwarded, [otherWarning], "a non-SQLite warning must still be forwarded");

    const otherExperimental = Object.assign(new Error("Fetch API is an experimental feature"), {
      name: "ExperimentalWarning",
    });
    process.emit("warning", otherExperimental);
    assert.deepEqual(
      forwarded,
      [otherWarning, otherExperimental],
      "a non-SQLite ExperimentalWarning must still be forwarded",
    );
  } finally {
    process.removeAllListeners("warning");
    for (const listener of originalListeners) {
      process.on("warning", listener as (warning: Error) => void);
    }
  }
});
