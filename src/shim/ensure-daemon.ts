// The stdio->HTTP shim's daemon auto-start (BUILD_BRIEF §4): whichever
// stdio client (Claude Desktop, Claude Code) starts the shim must find or
// start the one background daemon every client on the machine shares,
// without the user ever managing a service themselves. This is the very
// first thing that runs on a fresh install, so a confusing failure here is
// the difference between "it just works" and an unusable product.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHome, resolveCairnHome } from "../config/paths.js";
import { isDaemonAlive, readRuntimeFile } from "../daemon/runtime-file.js";
import type { RuntimeInfo } from "../daemon/runtime-file.js";

export interface EnsureDaemonOptions {
  home?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface EnsureDaemonResult {
  url: string;
  token: string;
  started: boolean;
  // The pid of the child process THIS call spawned, when it spawned one at
  // all (unset when an already-live daemon was found and nothing was
  // spawned). This can differ from the daemon named by the returned
  // url/token: two callers racing to spawn on the same runtime file can both
  // successfully bind and both start, but only one ends up owning
  // daemon.json (see the race comment below). Exposing this is what lets a
  // caller (in practice, only the test suite) clean up a spawned child it
  // owns even when that child turned out not to be the eventual owner --
  // nothing else in this module tracks that child's pid once this call
  // returns.
  spawnedPid?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

function toResult(info: RuntimeInfo, started: boolean, spawnedPid?: number): EnsureDaemonResult {
  return { url: `http://127.0.0.1:${info.port}`, token: info.token, started, spawnedPid };
}

// Resolved relative to this module's own file (dist/shim/ensure-daemon.js
// after build), never the process cwd: the shim is spawned by an MCP host
// from whatever directory that host happens to run in, which has nothing to
// do with where Cairn is installed. The daemon entrypoint is its sibling at
// dist/daemon/main.js.
function daemonEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "daemon", "main.js");
}

const LOG_TAIL_MAX_CHARS = 2_000;
const LOG_TAIL_MAX_LINES = 20;

// Best-effort tail of the daemon's own log, for folding into the timeout
// error below: a user (or CI run) hitting this gets the actual reason the
// daemon never came up instead of just a path to go looking for it
// themselves. Must never throw over the top of the real error -- the log may
// not exist yet, or be unreadable for any number of environment reasons.
function tailDaemonLog(logPath: string): string | null {
  try {
    const contents = readFileSync(logPath, "utf8");
    const lines = contents.split("\n").slice(-LOG_TAIL_MAX_LINES).join("\n");
    return lines.slice(-LOG_TAIL_MAX_CHARS);
  } catch {
    return null;
  }
}

async function pollForHealthyDaemon(home: string, deadline: number): Promise<RuntimeInfo | null> {
  for (;;) {
    const info = readRuntimeFile(home);
    if (info && (await isDaemonAlive(info))) {
      return info;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<EnsureDaemonResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? resolveCairnHome(env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const existing = readRuntimeFile(home);
  if (existing && (await isDaemonAlive(existing))) {
    return toResult(existing, false);
  }

  ensureHome(home);
  const logPath = join(home, "daemon.log");
  const entrypoint = daemonEntrypoint();

  // Two clients started at once (Claude Desktop and Claude Code launching
  // together, say) can both reach this point with no live runtime file and
  // both spawn a daemon child here. What happens next depends on the port:
  // with a FIXED port (the default, or CAIRN_PORT set to a specific
  // number), only one of the two daemons can ever bind it; daemon/main.ts's
  // startDaemon() call rejects with EADDRINUSE in the loser and that
  // process exits before ever calling writeRuntimeFile(). With an
  // EPHEMERAL port (CAIRN_PORT=0, as the test suite uses to avoid
  // collisions), BOTH daemons bind successfully and BOTH become "winners"
  // that call writeRuntimeFile() -- whoever writes last leaves the file
  // that actually matters, and there is no EADDRINUSE loser to fall back
  // on. Either way, neither caller of ensureDaemon() needs to pick a
  // winner itself: both fall through to the same poll loop below, which
  // waits for *a* runtime file to appear and answer /health, and then
  // re-reads the runtime file once more (below) so a caller that happened
  // to spawn the ephemeral-port race's eventual loser still returns the
  // file the actual last writer left behind, not a stale read from
  // mid-race.
  const logFd = openSync(logPath, "a");
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [entrypoint], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env: { ...env, CAIRN_HOME: home },
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  const deadline = Date.now() + timeoutMs;
  const info = await pollForHealthyDaemon(home, deadline);
  if (!info) {
    child.kill();
    const tail = tailDaemonLog(logPath);
    const tailMessage = tail
      ? ` Last output from "${logPath}":\n${tail}`
      : ` Check the daemon's log at "${logPath}" for what went wrong.`;
    throw new Error(
      `cairn: the daemon did not become healthy within ${timeoutMs}ms. ` +
        `Tried spawning "${entrypoint}" with CAIRN_HOME="${home}".` +
        tailMessage,
    );
  }
  const owner = readRuntimeFile(home) ?? info;
  return toResult(owner, true, child.pid);
}
