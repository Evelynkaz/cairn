import { chmodSync, mkdirSync, statSync } from "node:fs";
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

  // `mkdirSync`'s mode is a no-op when the directory already existed (e.g. a
  // CAIRN_HOME pointed at a synced/shared folder), so a pre-existing loose
  // mode survives untouched. Tighten it explicitly rather than trust
  // creation-time permissions alone -- the whole memory store lives here.
  //
  // POSIX mode bits are not meaningful on Windows: libuv reports
  // _S_IREAD|_S_IWRITE across all three permission triads there, so
  // `(mode & 0o077)` would read as permanently set and this would warn --
  // falsely, forever, on every call -- and chmodSync on Windows only clears
  // the read-only attribute, so it would never converge either. Skip the
  // check entirely on Windows; ACLs are the real (and different) boundary
  // there, not this.
  if (process.platform === "win32") {
    return home;
  }

  try {
    const { mode } = statSync(home);
    if ((mode & 0o077) !== 0) {
      chmodSync(home, 0o700);
      // stdout is the MCP transport in some code paths; diagnostics must
      // only ever go to stderr.
      process.stderr.write(
        `cairn: tightened permissions on ${home} to 0700 (it was world- or group-readable)\n`,
      );
    }
  } catch {
    // Best-effort: if we can't stat/chmod it, ensureHome still returns the
    // path rather than failing the caller.
  }

  return home;
}
