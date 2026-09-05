// One function per `cairn` command (BUILD_BRIEF §11, §16.5), each taking an
// injected I/O context instead of touching console.*/process.exit directly
// -- that is what makes every command testable without a real process, and
// this project has already been bitten by a module that did work at import
// time. index.ts is the only place that turns a return code into a real
// process.exit.

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir as osHomedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParsedCommand } from "./args.js";
import { TOP_LEVEL_COMMANDS } from "./args.js";
import { runSessionStartHook } from "./hook.js";
import {
  daemonStatus,
  disableEmbeddings,
  embeddingStatus,
  enableEmbeddings,
  startDaemonDetached,
  stopDaemon,
  uiUrl,
} from "./lifecycle.js";
import type { DaemonStatus, EmbeddingStatus } from "./lifecycle.js";
import { dbPath, resolveCairnHome } from "../config/paths.js";
import { applyToClients, cairnServerEntry, clientTargets } from "../setup/index.js";
import type { ApplyOutcome, ApplyResult } from "../setup/index.js";

export interface CommandContext {
  out(line: string): void;
  err(line: string): void;
  // Overrides CAIRN_HOME for the daemon/embedding commands (status, start,
  // stop, ui, embeddings ...) -- everything that resolves paths via
  // resolveCairnHome() in lifecycle.ts. `setup` does not use this: it talks
  // to per-client config files under the OS home directory, which is
  // isolated instead via `env.HOME`/`env.USERPROFILE` (see runSetup below).
  home?: string;
  env?: NodeJS.ProcessEnv;
  // Test-only escape hatches: override how long `stop` waits for the
  // daemon to die (default 10s is too slow for a test) and how the OS
  // home directory is resolved when HOME/USERPROFILE are both unset (see
  // runSetup/resolveOsHome below). Never set in production.
  stopTimeoutMs?: number;
  homedir?: () => string;
}

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

const HELP_TEXT = `cairn -- local-first memory MCP server

Usage:
  cairn                          run as the stdio MCP shim when not on a
                                  terminal (this is what an MCP client's
                                  {"command":"npx","args":["-y","cairn-mem@latest"]}
                                  launches); otherwise print status
  cairn mcp                      always run the stdio MCP shim
  cairn daemon                   run the daemon in the foreground
  cairn status [--json]          show daemon, embedding, and database state
  cairn start                    start the daemon detached
  cairn stop                     stop the running daemon
  cairn ui [--no-open]           ensure the daemon is running, print/open the dashboard URL
  cairn setup [--client=<id>...] [--dry-run] [--print]
                                  write cairn into Claude Desktop / Claude Code / Cursor configs
  cairn embeddings status [--json]
  cairn embeddings enable [--provider=<name>] [--model=<id>]
  cairn embeddings disable
  cairn hook session-start       print a Claude Code SessionStart hook envelope
                                  (see docs/RECALL_HOOK.md); never fails the session
  cairn help | --help | -h       show this help
  cairn --version                show the installed version

Note: bare "cairn" behaves differently depending on whether it is run from
a terminal (prints status) or launched by an MCP client (runs the shim) --
this is intentional, it is what makes the zero-config stdio client config
work. Use "cairn mcp" or "cairn status" to force one or the other.`;

export function helpText(): string {
  return HELP_TEXT;
}

// Exported for testing only: journalMode should surface in the human status
// output when (and only when) it is degraded (not "wal") -- a normal setup
// should not be noisy about it, but a degraded one (e.g. on a network home
// directory) must say so.
export function formatDaemonStatus(status: DaemonStatus): string[] {
  const lines: string[] = [];
  if (!status.running) {
    lines.push(
      status.staleRuntimeFile
        ? "daemon: not running (found a runtime file naming a dead process)"
        : "daemon: not running",
    );
    return lines;
  }
  lines.push(`daemon: running (pid ${status.pid}, port ${status.port}) -- ${status.url}`);
  if (status.memories !== undefined || status.vectors !== undefined) {
    const memories = status.memories !== undefined ? `${status.memories} memories` : "memories unknown";
    const vectors = status.vectors !== undefined ? `vectors: ${status.vectors}` : "vectors unknown";
    lines.push(`  ${memories}, ${vectors}`);
  }
  // A normal setup should not be noisy about this; a degraded one (not
  // "wal", e.g. on a network home directory) must say so.
  if (status.journalMode !== undefined && status.journalMode !== null && status.journalMode !== "wal") {
    lines.push(`  journal mode: ${status.journalMode} (degraded -- expected "wal")`);
  }
  return lines;
}

function formatEmbeddingStatus(status: EmbeddingStatus): string {
  const model = status.modelId ? ` model "${status.modelId}"` : "";
  const consent = status.consented ? "" : ", not consented";
  const available = status.available ? "available" : `unavailable (${status.reason ?? "unknown reason"})`;
  return `embeddings: provider "${status.provider}"${model}${consent} -- ${available}`;
}

// embeddingStatus opens the database and throws on a corrupt/unreadable
// file -- that must never take down the daemon half of the status (which
// resolved fine) or, for `status --json`, replace valid JSON with a raw
// stack trace. Substitute a status that carries the failure as its reason.
function safeEmbeddingStatus(home: string): EmbeddingStatus {
  try {
    return embeddingStatus(home);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      provider: "unknown",
      modelId: null,
      consented: false,
      source: "error",
      available: false,
      reason: `failed to read embedding status: ${reason}`,
    };
  }
}

async function collectStatus(home: string | undefined): Promise<{
  daemon: DaemonStatus;
  embeddings: EmbeddingStatus;
  dbPath: string;
}> {
  const resolvedHome = home ?? resolveCairnHome();
  const daemon = await daemonStatus(resolvedHome);
  const embeddings = safeEmbeddingStatus(resolvedHome);
  return { daemon, embeddings, dbPath: dbPath(resolvedHome) };
}

export async function runStatus(ctx: CommandContext, json: boolean): Promise<number> {
  const status = await collectStatus(ctx.home);
  if (json) {
    ctx.out(JSON.stringify(status));
    return 0;
  }
  for (const line of formatDaemonStatus(status.daemon)) {
    ctx.out(line);
  }
  ctx.out(formatEmbeddingStatus(status.embeddings));
  ctx.out(`database: ${status.dbPath}`);
  return 0;
}

export async function runRoot(ctx: CommandContext): Promise<number> {
  const code = await runStatus(ctx, false);
  ctx.out("");
  ctx.out('Not connected to an MCP client -- run "cairn setup" to configure one, or "cairn mcp" to run the stdio shim directly.');
  return code;
}

export async function runStart(ctx: CommandContext): Promise<number> {
  try {
    const result = await startDaemonDetached({ home: ctx.home, env: ctx.env });
    if (result.started) {
      ctx.out(`daemon started (pid ${result.pid}) at ${result.url}`);
    } else {
      ctx.out(`daemon already running at ${result.url}`);
    }
    return 0;
  } catch (error) {
    ctx.err(`failed to start the daemon: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function runStop(ctx: CommandContext): Promise<number> {
  const result = await stopDaemon({ home: ctx.home, timeoutMs: ctx.stopTimeoutMs });
  if (result.stopped) {
    ctx.out(`daemon stopped (pid ${result.pid})`);
    return 0;
  }
  const detail = result.detail ?? "daemon was not running";
  // A live daemon that was signalled but did not go away (ignored SIGTERM,
  // or the signal itself failed to deliver) must not be reported as
  // success -- "no daemon running" and "a stale runtime file was cleaned
  // up" are the only genuinely idempotent cases, both of which stay 0.
  const liveDaemonDidNotStop = detail.includes("did not stop within") || detail.includes("failed to signal");
  if (liveDaemonDidNotStop) {
    ctx.err(detail);
    return 1;
  }
  ctx.out(detail);
  return 0;
}

function openInBrowser(url: string): void {
  // No new dependencies: shell out to the OS's own "open a URL" command.
  // Best-effort only -- a failure here must never fail the command, since
  // the URL has already been printed for the user to open by hand.
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // Ignored: see comment above.
  }
}

export async function runUi(ctx: CommandContext, open: boolean): Promise<number> {
  try {
    await startDaemonDetached({ home: ctx.home, env: ctx.env });
  } catch (error) {
    ctx.err(`failed to start the daemon: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const url = await uiUrl(ctx.home);
  if (!url) {
    ctx.err("could not determine the dashboard URL -- is the daemon running?");
    return 1;
  }
  ctx.out(url);
  if (open) {
    openInBrowser(url);
  }
  return 0;
}

function humanOutcome(outcome: ApplyOutcome): string {
  switch (outcome) {
    case "created":
      return "created";
    case "updated":
      return "updated";
    case "replaced":
      return "replaced (an existing, different cairn entry was overwritten)";
    case "unchanged":
      return "unchanged";
    case "skipped-not-detected":
      return "skipped (not detected)";
    case "skipped-unparsable":
      return "skipped (unparsable)";
    case "failed":
      return "failed";
  }
}

const CLAUDE_CODE_HINT = "Claude Code can also be configured directly: claude mcp add cairn -- npx -y cairn-mem@latest";

const CLAUDE_CODE_LIVE_WRITE_NOTE =
  "note: ~/.claude.json is written continuously by a running Claude Code -- close it before running this, " +
  "or prefer the safer alternative: claude mcp add cairn -- npx -y cairn-mem@latest";

// Resolves the OS home directory the same way resolveCairnHome() does
// (env override, then the real OS home) so `setup`, which never touches
// CAIRN_HOME, cannot fall back to "" the way `env.HOME ?? env.USERPROFILE
// ?? ""` used to -- an empty string makes every client config path
// relative, so setup silently writes into the current directory instead of
// refusing. `homedirFn` is a test-only override; production always uses
// the real node:os homedir().
export function resolveOsHome(env: NodeJS.ProcessEnv, homedirFn: () => string = osHomedir): string {
  const fromEnv = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return homedirFn().trim();
}

export async function runSetup(
  ctx: CommandContext,
  options: { clients: string[]; dryRun: boolean; print: boolean },
): Promise<number> {
  const env = ctx.env ?? process.env;
  // clientTargets' own `home` parameter defaults from the real
  // process.env, not from whatever env object is passed as its first
  // argument -- pass it explicitly so an injected env (a test's isolated
  // HOME/USERPROFILE) actually takes effect.
  const osHome = resolveOsHome(env, ctx.homedir);
  if (!osHome) {
    ctx.err(
      "could not determine a home directory (no HOME or USERPROFILE environment variable, and the OS reported " +
        "none either) -- refusing to guess where to write client configs",
    );
    return 1;
  }
  let targets = clientTargets(env, process.platform, osHome);
  if (options.clients.length > 0) {
    const knownIds = new Set(targets.map((t) => t.id));
    const unknown = options.clients.filter((id) => !knownIds.has(id as (typeof targets)[number]["id"]));
    const wanted = new Set(options.clients);
    targets = targets.filter((t) => wanted.has(t.id));
    if (targets.length === 0) {
      ctx.err(`no known client matches: ${options.clients.join(", ")}; valid ids are: ${Array.from(knownIds).join(", ")}`);
      return 1;
    }
    if (unknown.length > 0) {
      // At least one requested client IS valid (targets.length > 0 above),
      // so this is a warning, not a fatal error -- the valid clients still
      // get configured.
      ctx.err(`WARNING: ignoring unknown --client value(s): ${unknown.join(", ")}; valid ids are: ${Array.from(knownIds).join(", ")}`);
    }
  }

  const configuresClaudeCode = targets.some((t) => t.id === "claude-code");

  if (options.print) {
    if (configuresClaudeCode) {
      ctx.out(CLAUDE_CODE_LIVE_WRITE_NOTE);
    }
    for (const target of targets) {
      const entry = cairnServerEntry(target);
      ctx.out(`${target.name} (${target.configPath}):`);
      ctx.out(JSON.stringify({ mcpServers: { cairn: entry } }, null, 2));
    }
    ctx.out("");
    ctx.out(CLAUDE_CODE_HINT);
    return 0;
  }

  if (configuresClaudeCode) {
    ctx.out(CLAUDE_CODE_LIVE_WRITE_NOTE);
  }

  const results: ApplyResult[] = applyToClients(targets, { dryRun: options.dryRun });
  let hadUnparsable = false;
  let hadFailure = false;
  for (const result of results) {
    if (result.outcome === "skipped-unparsable") {
      hadUnparsable = true;
      ctx.err(`WARNING: ${result.target.name} (${result.target.configPath}) could not be parsed and was left untouched: ${result.detail ?? ""}`);
      continue;
    }
    if (result.outcome === "failed") {
      hadFailure = true;
      ctx.err(`FAILED: ${result.target.name} (${result.target.configPath}): ${result.detail ?? "unknown error"}`);
      continue;
    }
    const backupNote = result.backupPath ? ` (backup: ${result.backupPath})` : "";
    ctx.out(`${result.target.name}: ${result.target.configPath} -- ${humanOutcome(result.outcome)}${backupNote}`);
    if (result.outcome === "replaced" && result.backupPath) {
      ctx.out(
        `  the previous cairn entry was overwritten -- if it was a deliberate custom install, restore it from ${result.backupPath}`,
      );
    }
  }
  ctx.out("");
  ctx.out(CLAUDE_CODE_HINT);
  return hadUnparsable || hadFailure ? 1 : 0;
}

export async function runEmbeddingsStatus(ctx: CommandContext, json: boolean): Promise<number> {
  try {
    const status = embeddingStatus(ctx.home);
    if (json) {
      ctx.out(JSON.stringify(status));
    } else {
      ctx.out(formatEmbeddingStatus(status));
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A `--json` flag that sometimes emits non-JSON is unusable by the
    // scripts it exists for -- keep the error path on stdout, as JSON,
    // when JSON was asked for.
    if (json) {
      ctx.out(JSON.stringify({ error: message }));
    } else {
      ctx.err(`failed to read embedding status: ${message}`);
    }
    return 1;
  }
}

export async function runEmbeddingsEnable(
  ctx: CommandContext,
  options: { provider?: string; modelId?: string },
): Promise<number> {
  try {
    const status = enableEmbeddings({ home: ctx.home, provider: options.provider, modelId: options.modelId });
    ctx.out(formatEmbeddingStatus(status));
    return 0;
  } catch (error) {
    ctx.err(`failed to enable embeddings: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function runEmbeddingsDisable(ctx: CommandContext): Promise<number> {
  try {
    const status = disableEmbeddings(ctx.home);
    ctx.out(formatEmbeddingStatus(status));
    return 0;
  } catch (error) {
    ctx.err(`failed to disable embeddings: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// The hook's own contract (see hook.ts's header) is to never throw and to
// never produce a non-empty result on any failure path -- but this wrapper
// still catches defensively and always returns 0, so that even a bug that
// violates that contract cannot turn a SessionStart hook into something
// that blocks or visibly fails a session.
export async function runHookSessionStart(ctx: CommandContext): Promise<number> {
  try {
    const result = await runSessionStartHook({ home: ctx.home, stdin: process.stdin });
    if (result.stdout) {
      ctx.out(result.stdout);
    }
  } catch {
    // Never surface anything here -- see hook.ts's header comment.
  }
  return 0;
}

export function runHelp(ctx: CommandContext): number {
  ctx.out(helpText());
  return 0;
}

export function runVersion(ctx: CommandContext): number {
  ctx.out(packageVersion());
  return 0;
}

export function runError(ctx: CommandContext, message: string): number {
  ctx.err(message);
  ctx.err(`valid commands are: ${TOP_LEVEL_COMMANDS.join(", ")}`);
  return 1;
}

// Handles every command except "mcp", "daemon", and a "root" reached with a
// non-TTY stdin -- those three own the process (stdio transport, signal
// handlers) and are dispatched directly by index.ts instead.
export async function runCommand(parsed: ParsedCommand, ctx: CommandContext): Promise<number> {
  switch (parsed.command) {
    case "root":
      return runRoot(ctx);
    case "help":
      return runHelp(ctx);
    case "version":
      return runVersion(ctx);
    case "status":
      return runStatus(ctx, parsed.json);
    case "start":
      return runStart(ctx);
    case "stop":
      return runStop(ctx);
    case "ui":
      return runUi(ctx, parsed.open);
    case "setup":
      return runSetup(ctx, { clients: parsed.clients, dryRun: parsed.dryRun, print: parsed.print });
    case "embeddings-status":
      return runEmbeddingsStatus(ctx, parsed.json);
    case "embeddings-enable":
      return runEmbeddingsEnable(ctx, { provider: parsed.provider, modelId: parsed.modelId });
    case "embeddings-disable":
      return runEmbeddingsDisable(ctx);
    case "hook-session-start":
      return runHookSessionStart(ctx);
    case "error":
      return runError(ctx, parsed.message);
    case "mcp":
    case "daemon":
      // index.ts must intercept these before calling runCommand.
      return runError(ctx, `"cairn ${parsed.command}" must be handled by the entrypoint, not runCommand`);
  }
}
