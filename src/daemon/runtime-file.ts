// How a client (the stdio->HTTP shim, the CLI, another daemon invocation)
// discovers an already-running daemon: `<CAIRN_HOME>/daemon.json`. This file
// is the rendezvous point for the §4 "one daemon, many clients" story --
// nothing here talks to the database.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
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
const RUNTIME_FILE_MODE = 0o600;

export function writeRuntimeFile(info: RuntimeInfo, home: string = resolveCairnHome()): void {
  ensureHome(home);
  writeFileSync(runtimeFilePath(home), JSON.stringify(info, null, 2), { mode: RUNTIME_FILE_MODE });
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

function pidIsAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing; it only probes whether the process exists and
    // is reachable, on both POSIX and Windows.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portAnswers(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const finish = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

// A stale runtime file left by a daemon that crashed (or a reboot that
// killed it without cleanup) is the normal case, not an exception -- so this
// checks liveness on two independent signals rather than trusting the file.
export async function isDaemonAlive(info: RuntimeInfo): Promise<boolean> {
  if (!pidIsAlive(info.pid)) {
    return false;
  }
  return portAnswers(info.port);
}
