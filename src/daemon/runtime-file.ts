// How a client (the stdio->HTTP shim, the CLI, another daemon invocation)
// discovers an already-running daemon: `<CAIRN_HOME>/daemon.json`. This file
// is the rendezvous point for the §4 "one daemon, many clients" story --
// nothing here talks to the database.

import { closeSync, fchmodSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ensureHome, resolveCairnHome } from "../config/paths.js";

export interface RuntimeInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
  version: string;
}

export function runtimeFilePath(home: string = resolveCairnHome()): string {
  return join(home, "daemon.json");
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

// Mode 0600 matters on macOS/Linux because this file carries the bearer
// token. It is a no-op on Windows (no POSIX permission bits on NTFS), so on
// Windows the token's real protection is the user's profile directory
// (nobody else can read %USERPROFILE% by default) rather than this mode
// bit. Either way the token is defence-in-depth, not the primary boundary --
// the primary boundary is binding the daemon to loopback only (see
// server.ts), which keeps the token off the network entirely.
//
// `{ mode }` on writeFileSync only applies when the call CREATES the file --
// a `daemon.json` planted in advance (by a co-resident attacker, or just
// left behind at a looser mode from an older Cairn) keeps its existing mode
// forever, silently, no matter how many times the token is rotated. To
// actually guarantee 0600 on every write, this always creates a brand-new
// file under a temp name with `wx` (fails if that exact name exists, so it
// can't be tricked into writing through a pre-planted symlink), forces the
// mode with `fchmodSync` on the open descriptor (belt-and-suspenders against
// a loose umask), and only then renames it over the real path --
// `renameSync` replaces whatever is at the destination, including a symlink,
// without ever opening or following it, so a symlink planted at
// `daemon.json` is inert. The rename is also atomic, so `readRuntimeFile`
// never observes a half-written file.
const RUNTIME_FILE_MODE = 0o600;

export function writeRuntimeFile(info: RuntimeInfo, home: string = resolveCairnHome()): void {
  ensureHome(home);
  const path = runtimeFilePath(home);
  const tmpPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmpPath, "wx", RUNTIME_FILE_MODE);
  try {
    fchmodSync(fd, RUNTIME_FILE_MODE);
    writeSync(fd, JSON.stringify(info, null, 2));
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
}

function isRuntimeInfo(value: unknown): value is RuntimeInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.pid === "number" &&
    typeof v.port === "number" &&
    typeof v.token === "string" &&
    typeof v.startedAt === "number" &&
    typeof v.version === "string"
  );
}

// A missing or corrupt runtime file means "no daemon is running" -- the
// normal state right after install, or after a crash that left a stale/
// partial write. It must never throw: the caller's job on null is simply to
// start a daemon, not to handle an exceptional error path.
export function readRuntimeFile(home: string = resolveCairnHome()): RuntimeInfo | null {
  try {
    const raw = readFileSync(runtimeFilePath(home), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isRuntimeInfo(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function removeRuntimeFile(home: string = resolveCairnHome()): void {
  rmSync(runtimeFilePath(home), { force: true });
}

export function pidIsAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing; it only probes whether the process exists and
    // is reachable, on both POSIX and Windows.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface HealthProbeBody {
  ok?: unknown;
  pid?: unknown;
}

function isHealthProbeBody(value: unknown): value is HealthProbeBody {
  return typeof value === "object" && value !== null;
}

// A pid existing and a port answering are each independently meaningless:
// pids are recycled by the OS and any local service can be holding the
// recorded port, so neither one -- nor both together -- identifies the
// process as the cairn daemon. /health carries the daemon's own pid (see
// server.ts) precisely so this can compare it against the runtime file's
// pid rather than inferring identity from coincidence.
async function healthIdentifiesDaemon(info: RuntimeInfo, timeoutMs = 500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: controller.signal });
    if (!res.ok) {
      return false;
    }
    const body: unknown = await res.json();
    return isHealthProbeBody(body) && body.ok === true && body.pid === info.pid;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// A stale runtime file left by a daemon that crashed (or a reboot that
// killed it without cleanup) is the normal case, not an exception -- so this
// checks liveness on two independent signals rather than trusting the file.
// Both signals must also PROVE identity, not just presence: a recycled pid
// or a foreign service that happened to take the recorded port must read as
// "not alive", not as "alive" -- see healthIdentifiesDaemon above. This
// matters beyond liveness reporting: ensureDaemon (shim/ensure-daemon.ts)
// uses this to decide whether to ATTACH to a daemon and hand it the bearer
// token, and stopDaemon (cli/lifecycle.ts) uses it to decide whether to
// signal the recorded pid at all.
export async function isDaemonAlive(info: RuntimeInfo): Promise<boolean> {
  if (!pidIsAlive(info.pid)) {
    return false;
  }
  return healthIdentifiesDaemon(info);
}
