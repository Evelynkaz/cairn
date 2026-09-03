import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  statSync,
  lstatSync,
  realpathSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ClientTarget } from "./clients.js";
// BLOCKED (see setup builder receipt): src/daemon/server.ts owns the
// daemon's default port (8787) but does not export it, and that file is
// locked by a concurrent builder. Importing it here rather than
// redeclaring the number, per spec -- this import will not resolve until
// DEFAULT_PORT is exported from ../daemon/server.js.
import { DEFAULT_PORT } from "../daemon/server.js";

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
  return { command: "npx", args: ["-y", "cairn@latest"] };
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
// The write itself goes to a sibling `.cairn-tmp` file and is renamed onto
// the target, so a crash or a full disk mid-write cannot leave a truncated
// config -- the rename is atomic and either lands the whole new file or
// nothing changes. If configPath is a symlink, we write through it (to the
// real target) instead of letting renameSync replace the link itself with
// a plain file, which would silently break the symlink.
function writeConfig(configPath: string, config: Record<string, unknown>): void {
  let target = configPath;
  try {
    if (lstatSync(configPath).isSymbolicLink()) {
      target = realpathSync(configPath);
    }
  } catch {
    // configPath does not exist yet -- write it directly.
  }

  let mode: number | undefined;
  try {
    mode = statSync(target).mode;
  } catch {
    // No existing file to inherit permissions from.
  }

  const tmpPath = `${target}.cairn-tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  try {
    if (mode !== undefined) {
      chmodSync(tmpPath, mode);
    }
    renameSync(tmpPath, target);
  } catch (err) {
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
  const raw = exists ? readFileSync(target.configPath, "utf8").replace(/^﻿/, "") : undefined;
  const isEmpty = raw !== undefined && raw.trim() === "";

  if (!exists || isEmpty) {
    if (!options.dryRun) {
      try {
        mkdirSync(dirname(target.configPath), { recursive: true });
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
