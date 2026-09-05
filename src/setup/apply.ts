import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  copyFileSync,
  renameSync,
  statSync,
  lstatSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { ClientTarget } from "./clients.js";
// BLOCKED (see setup builder receipt): src/daemon/server.ts owns the
// daemon's default port (8787) but does not export it, and that file is
// locked by a concurrent builder. Importing it here rather than
// redeclaring the number, per spec -- this import will not resolve until
// DEFAULT_PORT is exported from ../daemon/server.js.
import { DEFAULT_PORT } from "../daemon/server.js";

// New configs and directories are created with a restrictive default so a
// user's later-added server credentials never inherit a world-readable
// mode; an *existing* file's own mode is always preserved instead (see
// writeConfig below).
const NEW_FILE_MODE = 0o600;
const NEW_DIR_MODE = 0o700;

// Test-only seam: forces the temp-file suffix so a test can plant a symlink
// at the exact path the code will try to open and prove O_EXCL|O_NOFOLLOW
// refuses it. Not used by any production call path -- the whole point of
// randomising the suffix is that it is normally unguessable.
let tmpSuffixForTesting: string | undefined;
export function __setTmpSuffixForTesting(suffix: string | undefined): void {
  tmpSuffixForTesting = suffix;
}

export interface ServerEntry {
  command?: string;
  args?: string[];
  url?: string;
  type?: string;
}

export type ApplyOutcome =
  | "created"
  | "updated"
  | "replaced"
  | "unchanged"
  | "skipped-unparsable"
  | "skipped-not-detected"
  | "failed";

export interface ApplyResult {
  target: ClientTarget;
  outcome: ApplyOutcome;
  backupPath?: string;
  detail?: string;
}

export function cairnServerEntry(target: ClientTarget, options: { port?: number } = {}): ServerEntry {
  if (target.transport === "http") {
    const port = options.port ?? DEFAULT_PORT;
    return { url: `http://127.0.0.1:${port}/mcp`, type: "http" };
  }
  return { command: "npx", args: ["-y", "cairn-mem@latest"] };
}

function backupSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Config is written with two-space indent and a trailing newline; existing
// unrelated content is round-tripped through JSON.parse/stringify, which
// normalises formatting (e.g. key order, spacing) but preserves values.
// The write itself goes to a sibling temp file and is renamed onto the
// target, so a crash or a full disk mid-write cannot leave a truncated
// config -- the rename is atomic and either lands the whole new file or
// nothing changes. If configPath is a symlink, we write through it (to the
// real target) instead of letting renameSync replace the link itself with
// a plain file, which would silently break the symlink.
//
// The temp name is randomised so it cannot be pre-planted by an attacker
// who can create files in the same directory, and it is opened with
// O_EXCL|O_NOFOLLOW so even a guessed/racing name refuses to write through
// an existing path or a symlink there -- a fixed, predictable temp path
// followed through a planted symlink was how a prior version of this
// function could be made to write (and chmod, and rename) an attacker's
// file instead of the real target. O_NOFOLLOW is POSIX; Node accepts the
// flag on Windows too but it has no effect there (no symlink-following
// distinction at this layer), so this degrades to "no worse than before"
// on Windows rather than changing behaviour on POSIX. The file is written
// and mode-set through the open file descriptor (fchmodSync, never
// chmodSync on a path) so it is never briefly world-readable between
// creation and the permission fix-up.
function writeConfig(configPath: string, config: Record<string, unknown>, defaultMode = NEW_FILE_MODE): void {
  let target = configPath;
  try {
    if (lstatSync(configPath).isSymbolicLink()) {
      target = realpathSync(configPath);
    }
  } catch {
    // configPath does not exist yet -- write it directly.
  }

  let mode = defaultMode;
  try {
    mode = statSync(target).mode;
  } catch {
    // No existing file to inherit permissions from -- use the restrictive default.
  }

  const tmpPath = `${target}.cairn-tmp-${tmpSuffixForTesting ?? randomBytes(6).toString("hex")}`;
  const fd = openSync(
    tmpPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let closed = false;
  try {
    writeSync(fd, `${JSON.stringify(config, null, 2)}\n`, null, "utf8");
    fchmodSync(fd, mode);
    closeSync(fd);
    closed = true;
    renameSync(tmpPath, target);
  } catch (err) {
    if (!closed) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort close on the failure path.
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort: the original error is what matters to the caller.
    }
    throw err;
  }
}

export function applyToClient(
  target: ClientTarget,
  options: { port?: number; dryRun?: boolean } = {},
): ApplyResult {
  if (!target.detected) {
    return { target, outcome: "skipped-not-detected" };
  }

  const entry = cairnServerEntry(target, { port: options.port });
  const exists = existsSync(target.configPath);

  // A BOM-prefixed file (common from PowerShell's `Set-Content -Encoding
  // UTF8` or a BOM-defaulting editor) is otherwise perfectly valid JSON;
  // strip it before parsing. An empty or whitespace-only file (e.g. a
  // `touch`ed config) has nothing to round-trip either, so treat it the
  // same as "no file" rather than reporting it unparsable.
  let raw: string | undefined;
  if (exists) {
    try {
      raw = readFileSync(target.configPath, "utf8").replace(/^﻿/, "");
    } catch (err) {
      return {
        target,
        outcome: "failed",
        detail: `${target.configPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const isEmpty = raw !== undefined && raw.trim() === "";

  if (!exists || isEmpty) {
    if (!options.dryRun) {
      try {
        mkdirSync(dirname(target.configPath), { recursive: true, mode: NEW_DIR_MODE });
        writeConfig(target.configPath, { mcpServers: { cairn: entry } });
      } catch (err) {
        return {
          target,
          outcome: "failed",
          detail: `${target.configPath}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    return { target, outcome: "created" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw!);
  } catch (err) {
    return {
      target,
      outcome: "skipped-unparsable",
      detail: `${target.configPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Valid JSON but not a plain object (e.g. an array or a string) cannot be
  // safely merged into — there is no `mcpServers` key to add. Treat it the
  // same as unparsable: leave the file untouched rather than guess.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      target,
      outcome: "skipped-unparsable",
      detail: `${target.configPath}: expected a JSON object at the top level, got ${Array.isArray(parsed) ? "an array" : typeof parsed}`,
    };
  }

  const config = parsed as Record<string, unknown>;

  // Same treatment for `mcpServers`: if it is present but not a plain
  // object, coercing it to {} would silently discard whatever was there
  // (a string, an array, ...). Refuse instead of guessing.
  if (
    "mcpServers" in config &&
    (typeof config.mcpServers !== "object" || config.mcpServers === null || Array.isArray(config.mcpServers))
  ) {
    return {
      target,
      outcome: "skipped-unparsable",
      detail: `${target.configPath}: expected mcpServers to be an object, got ${
        Array.isArray(config.mcpServers) ? "an array" : typeof config.mcpServers
      }`,
    };
  }

  const existingServers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
  const hadCairn = Object.prototype.hasOwnProperty.call(existingServers, "cairn");

  if (deepEqual(existingServers.cairn, entry)) {
    return { target, outcome: "unchanged" };
  }

  const nextConfig: Record<string, unknown> = {
    ...config,
    mcpServers: { ...existingServers, cairn: entry },
  };

  // "replaced" means there was already a different cairn entry (e.g. a dev
  // install) that this overwrites; "updated" keeps its original meaning of
  // "the file changed but there was no prior cairn entry".
  const outcome: ApplyOutcome = hadCairn ? "replaced" : "updated";

  if (options.dryRun) {
    return { target, outcome };
  }

  // Check writability explicitly, before touching anything, rather than
  // letting the write fail on its own: on POSIX, renaming a new file onto
  // an existing one only needs write permission on the *directory*, not on
  // the target file, so a `chmod 444` config would otherwise be silently
  // replaced -- atomic rename would defeat the file's own permissions. A
  // read-only file is the user telling the tool not to touch it; honour
  // that the same way on every platform.
  try {
    accessSync(target.configPath, constants.W_OK);
  } catch (err) {
    return {
      target,
      outcome: "failed",
      detail: `${target.configPath}: not writable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const backupPath = `${target.configPath}.cairn-backup-${backupSuffix()}`;
  try {
    copyFileSync(target.configPath, backupPath);
  } catch (err) {
    return {
      target,
      outcome: "failed",
      detail: `${target.configPath}: backup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    writeConfig(target.configPath, nextConfig);
  } catch (err) {
    try {
      unlinkSync(backupPath);
    } catch {
      // Best-effort: the write error is what matters to the caller.
    }
    return {
      target,
      outcome: "failed",
      detail: `${target.configPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { target, outcome, backupPath };
}

export function applyToClients(
  targets: ClientTarget[],
  options: { port?: number; dryRun?: boolean } = {},
): ApplyResult[] {
  return targets.map((target) => applyToClient(target, options));
}
