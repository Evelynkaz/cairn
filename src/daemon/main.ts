// Process entrypoint for the daemon (BUILD_BRIEF §4). `startDaemon` itself
// is a library function with no process side effects (see its own comment
// on why) -- this file is the one place that owns the process: it installs
// SIGINT/SIGTERM handlers, reads the daemon's environment configuration,
// and keeps the process alive until told to stop.

import { pathToFileURL } from "node:url";
import { startDaemon } from "./server.js";
import type { DaemonHandle } from "./server.js";

function readPort(): number | undefined {
  const raw = process.env.CAIRN_PORT;
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function main(): Promise<void> {
  // Installed BEFORE startDaemon() is even called: openStore and its
  // migrations run inside startDaemon() after the port is already bound
  // (measured at 200-400ms), and a signal landing in that window must not
  // leave the port claimed with no runtime file for a polling client to
  // find. `handle` is undefined for exactly that window; `closeRequested`
  // is how a signal that arrives during it gets honoured once startDaemon()
  // finally resolves, instead of being lost.
  let handle: DaemonHandle | undefined;
  let shuttingDown = false;
  let closeRequested = false;

  async function closeAndExit(h: DaemonHandle): Promise<void> {
    try {
      await h.close();
    } catch (err) {
      // stdout is the MCP transport on some code paths -- every diagnostic,
      // including one from a failed shutdown, goes to stderr only.
      process.stderr.write(
        `cairn daemon: error while shutting down: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
    }
    process.exit(0);
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) {
      return;
    }
    if (!handle) {
      closeRequested = true;
      return;
    }
    shuttingDown = true;
    await closeAndExit(handle);
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  // SIGHUP: the detached daemon's parent terminal closing. Handled the same
  // as SIGINT/SIGTERM so the runtime file is always removed on exit, never
  // left behind naming a pid that is no longer running.
  process.on("SIGHUP", () => void shutdown());

  // CAIRN_HOME is not read here directly: it is picked up by startDaemon's
  // own dependencies (openStore/runtime-file) via resolveCairnHome(), which
  // reads process.env.CAIRN_HOME itself. CAIRN_DB overrides the db file
  // path within that home; CAIRN_PORT overrides the bind port.
  handle = await startDaemon({ port: readPort(), dbPath: process.env.CAIRN_DB });

  if (closeRequested) {
    shuttingDown = true;
    await closeAndExit(handle);
    return;
  }

  // Exactly one line, to stderr only: the shim (and any developer watching
  // the daemon's log file) needs this to know the daemon is up and where,
  // but stdout is reserved for the MCP protocol in this project and no
  // process may treat it as a place to print banners.
  process.stderr.write(`cairn daemon listening on ${handle.url}\n`);
}

// Runs main() only when this file is executed directly as a program (the
// shim's ensureDaemon() spawning `node dist/daemon/main.js`), never merely
// imported -- a test importing this module, or a future CLI importing it to
// call something else out of it, must not spawn a real daemon against the
// user's real CAIRN_HOME as a side effect of the import. process.argv[1] can
// be undefined (e.g. `node -e`), so treat that as "not the entrypoint" rather
// than throwing on the pathToFileURL() call below.
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((err) => {
    process.stderr.write(`cairn daemon failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
