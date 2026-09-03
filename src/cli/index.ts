#!/usr/bin/env node
// The `cairn` bin (package.json's bin.cairn -> dist/cli/index.js).
//
// BUILD_BRIEF §11 specifies the stdio client config as
// {"command":"npx","args":["-y","cairn@latest"]} -- no subcommand. That
// means a bare `cairn`, when launched BY an MCP client, must BE the stdio
// shim. When a human runs it in a terminal instead, it should report status
// -- nobody wants a terminal command that silently hangs waiting for JSON-RPC
// on stdin. This is dispatched on process.stdin.isTTY: not a TTY -> run the
// shim; a TTY -> print status (as `cairn status` would) plus a hint. This is
// surprising behaviour, documented prominently here because it is the only
// way to satisfy §11's zero-config client snippet. `cairn mcp` always runs
// the shim and `cairn status` always prints status, regardless of TTY, for
// anyone who wants a deterministic escape hatch.
//
// *** When the shim path is taken, stdout is the MCP transport. ***
// Every diagnostic in that path goes to stderr -- a stray stdout line
// corrupts the JSON-RPC stream (see src/shim/index.ts's own header comment).
//
// Wrapped in an entrypoint guard (isEntrypoint below) so importing this
// module does nothing: this project has already shipped a bug where
// importing an entrypoint spawned a daemon against the user's real home.

import { pathToFileURL } from "node:url";
import { parseArgs } from "./args.js";
import type { CommandContext } from "./commands.js";

// Node prints "ExperimentalWarning: SQLite is an experimental feature and
// might change at any time" the moment `node:sqlite` is first loaded, which
// happens as a side effect of importing the storage layer (commands.js ->
// lifecycle.js -> storage/db.js -> storage/driver/node-sqlite.ts). That is
// our own implementation detail, not something the user chose or can act
// on, and `npx cairn` is this project's zero-config front door (BUILD_BRIEF
// §2) -- a scary experimental-feature warning as the very first line of
// output makes it look broken. This suppresses ONLY that one warning:
// it saves Node's own default "warning" listener and re-delegates every
// OTHER warning (real deprecations included) to it unchanged, instead of
// reimplementing Node's formatting, so nothing else goes quiet. Delete this
// whole function, and its call sites, once Node ships `node:sqlite` as
// stable and the warning stops firing.
export function suppressExperimentalSqliteWarning(): void {
  const defaultListeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning: Error) => {
    if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) {
      return;
    }
    for (const listener of defaultListeners) {
      listener(warning);
    }
  });
}

function stderrContext(): CommandContext {
  return {
    out: (line) => process.stderr.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

function stdoutContext(): CommandContext {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

// Runs a command that returns an exit code once it is done -- everything
// except the shim and the foreground daemon, both of which own the
// process's lifetime themselves (see runProcessOwningCommand below) and
// must never have process.exit() called out from under them by this
// function.
export async function run(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const { runCommand, runError } = await import("./commands.js");
  if (parsed.command === "error") {
    return runError(stderrContext(), parsed.message);
  }
  return runCommand(parsed, stdoutContext());
}

// The shim (BUILD_BRIEF §4) and the foreground daemon each keep the process
// alive on their own open handles (stdio transport, HTTP server) and exit
// it themselves (on stdin EOF, a signal, or an unrecoverable error) -- they
// never "finish" the way an ordinary command does. Calling process.exit()
// after awaiting either of them here would kill the process the instant
// startup completes, which is why they are dispatched here, before run()'s
// exit-code plumbing, instead of through runCommand().
async function runProcessOwningCommand(argv: string[]): Promise<boolean> {
  const parsed = parseArgs(argv);
  if (parsed.command === "mcp" || (parsed.command === "root" && !process.stdin.isTTY)) {
    const { main: runShimMain } = await import("../shim/index.js");
    await runShimMain();
    return true;
  }
  if (parsed.command === "daemon") {
    const { main: runDaemonForeground } = await import("../daemon/main.js");
    await runDaemonForeground();
    return true;
  }
  return false;
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  suppressExperimentalSqliteWarning();
  const argv = process.argv.slice(2);
  runProcessOwningCommand(argv)
    .then((handled) => {
      if (handled) {
        return;
      }
      return run(argv).then((code) => process.exit(code));
    })
    .catch((err: unknown) => {
      process.stderr.write(`cairn: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    });
}
