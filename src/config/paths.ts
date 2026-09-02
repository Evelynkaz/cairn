import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveCairnHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CAIRN_HOME?.trim();
  if (override) {
    return resolve(override);
  }
  return join(homedir(), ".cairn");
}

export function dbPath(home: string = resolveCairnHome()): string {
  return join(home, "cairn.db");
}

export function ensureHome(home: string = resolveCairnHome()): string {
  // mode is a no-op on Windows filesystems (no POSIX permission bits) but
  // still correct and idempotent there; it matters on macOS/Linux.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}
