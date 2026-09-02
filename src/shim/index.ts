#!/usr/bin/env node
// The stdio->HTTP shim (BUILD_BRIEF §4): bridges an MCP client that only
// speaks stdio (Claude Desktop, Claude Code) to the one daemon every client
// on the machine shares, auto-starting it via ensureDaemon() if needed.
// This is a process entrypoint, not a library -- stdio-only hosts spawn it
// directly and talk MCP to it over stdin/stdout.
//
// *** stdout is the MCP transport. ***
// Nothing may ever be written to it except protocol bytes coming out of
// StdioServerTransport itself -- no logs, no banners, no console.log, not
// even for debugging. A single stray line on stdout corrupts the JSON-RPC
// stream and produces a failure that looks exactly like a bug in the
// client, not in this file. Every diagnostic below goes to stderr via
// process.stderr.write. (Node's own ExperimentalWarning for `node:sqlite`
// does not arise here: the daemon that touches SQLite is a separate
// process, spawned with its own stdio.)
//
// Daemon-death recovery: if the daemon dies while the stdio client is still
// attached, the shim does NOT stay up forwarding to a dead transport forever
// (that leaves the user's tools silently and permanently broken until they
// restart their whole MCP client). It detects this from the HTTP transport's
// onerror (which the SDK fires for every failed send -- in practice the
// only reliable signal, since StreamableHTTPClientTransport only calls
// onclose from its own close(), never from the server vanishing) and from
// onclose itself, kept for defensiveness. Either one retries `ensureDaemon()`
// a bounded number of times with a short backoff, rebuilding the HTTP
// transport on success. If every attempt fails, it exits non-zero so the
// MCP host respawns the shim -- which re-runs ensureDaemon() from a clean
// process. Reconnecting in place is preferred over exiting immediately
// because it is invisible to the stdio client (no dropped connection, no
// host-side respawn delay) whenever the daemon simply restarts underneath
// it. A rebuilt HTTP transport talks to a daemon that has never seen this
// session, though, and the daemon rejects any non-initialize request on an
// unrecognized session with 400 -- so a reconnect attempt also replays the
// original `initialize` request (and the `notifications/initialized` that
// followed it) under a synthetic id before the new transport is handed
// live traffic, and only counts as successful once the daemon answers that
// replay. The replay's own response is intercepted and never forwarded to
// the real stdio client, which already got its answer to the original
// initialize long ago.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  isInitializedNotification,
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage, JSONRPCRequest, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { pathToFileURL } from "node:url";
import { ensureDaemon } from "./ensure-daemon.js";
import type { EnsureDaemonResult } from "./ensure-daemon.js";

function logDiagnostic(message: string): void {
  process.stderr.write(`[cairn-shim] ${message}\n`);
}

const DEFAULT_RECONNECT_DELAYS_MS = [250, 500, 1000];

interface StdinLike {
  on(event: "end", listener: () => void): void;
}

export interface RunShimOptions {
  stdioTransport: Transport;
  ensureDaemon: () => Promise<EnsureDaemonResult>;
  makeHttpTransport: (daemon: EnsureDaemonResult) => Transport;
  log?: (message: string) => void;
  exit?: (code: number) => void;
  stdin?: StdinLike;
  reconnectDelaysMs?: number[];
}

export async function runShim(options: RunShimOptions): Promise<void> {
  const { stdioTransport } = options;
  const log = options.log ?? logDiagnostic;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const stdin = options.stdin ?? process.stdin;
  const reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;

  let shuttingDown = false;
  let reconnecting = false;
  let httpTransport: Transport;

  // Requests forwarded to the daemon that have not yet had a response
  // forwarded back. If the daemon dies mid-session, every request still in
  // this set gets a real JSON-RPC error response instead of hanging forever
  // or the shim crashing silently.
  const pending = new Set<RequestId>();

  // The client's original MCP handshake, cached so a reconnect can replay
  // it against a fresh daemon that has never seen this session (see the
  // module-level comment above). Replay responses are matched here and
  // never forwarded to the real stdio client.
  let cachedInitialize: JSONRPCRequest | undefined;
  let cachedInitializedNotification: JSONRPCMessage | undefined;
  const pendingReplays = new Map<RequestId, (message: JSONRPCMessage) => void>();
  let replayCounter = 0;

  function failPendingRequests(reason: string): void {
    for (const id of pending) {
      const errorResponse: JSONRPCMessage = {
        jsonrpc: "2.0",
        id,
        error: { code: ErrorCode.ConnectionClosed, message: `cairn daemon connection lost: ${reason}` },
      };
      void stdioTransport.send(errorResponse).catch(() => {});
    }
    pending.clear();
  }

  function failOneRequest(id: RequestId, reason: string): void {
    if (!pending.delete(id)) {
      return;
    }
    const errorResponse: JSONRPCMessage = {
      jsonrpc: "2.0",
      id,
      error: { code: ErrorCode.ConnectionClosed, message: `cairn daemon connection lost: ${reason}` },
    };
    void stdioTransport.send(errorResponse).catch(() => {});
  }

  const REPLAY_TIMEOUT_MS = 5000;

  // Replays the cached initialize handshake against a freshly reconnected
  // transport, under a synthetic id the real stdio client never sees, so the
  // new daemon accepts this session before it is handed live traffic. A
  // reconnect with no cached handshake yet (the daemon died before the
  // client ever initialized) is a no-op -- vanishingly rare in practice,
  // since a client's first message is always `initialize`.
  function replayInitialize(transport: Transport): Promise<void> {
    if (!cachedInitialize) {
      return Promise.resolve();
    }
    const initializeRequest = cachedInitialize;
    const replayId = `__cairn_shim_reconnect_init_${++replayCounter}__`;
    const replayRequest: JSONRPCMessage = { ...initializeRequest, id: replayId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingReplays.delete(replayId);
        reject(new Error("timed out waiting for the daemon to answer the replayed initialize request"));
      }, REPLAY_TIMEOUT_MS);
      pendingReplays.set(replayId, (message) => {
        clearTimeout(timer);
        if (isJSONRPCErrorResponse(message)) {
          reject(new Error(`daemon rejected the replayed initialize request: ${message.error.message}`));
          return;
        }
        if (cachedInitializedNotification) {
          void transport.send(cachedInitializedNotification).catch(() => {});
        }
        resolve();
      });
      transport.send(replayRequest).catch((err: unknown) => {
        clearTimeout(timer);
        pendingReplays.delete(replayId);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  async function reconnectToDaemon(): Promise<void> {
    // Held onto so it can be closed once a working replacement is live --
    // otherwise its own send() calls that were already in flight when it
    // died keep rejecting afterward, each one re-triggering onerror. Without
    // this, a late rejection from the OLD transport (see the `transport ===
    // httpTransport` guards below) could start a second, untracked reconnect
    // after this one already succeeded, spawning a daemon nothing cleans up.
    const previous = httpTransport;
    for (let attempt = 0; attempt < reconnectDelaysMs.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, reconnectDelaysMs[attempt]));
      try {
        const daemon = await options.ensureDaemon();
        const next = options.makeHttpTransport(daemon);
        wireHttpTransport(next);
        await next.start();
        await replayInitialize(next);
        httpTransport = next;
        void previous.close().catch(() => {});
        log(`reconnected to the daemon at ${daemon.url} after connection loss (attempt ${attempt + 1}/${reconnectDelaysMs.length})`);
        return;
      } catch (err) {
        log(`reconnect attempt ${attempt + 1}/${reconnectDelaysMs.length} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log(`could not reconnect to the daemon after ${reconnectDelaysMs.length} attempts; exiting so the MCP host respawns the shim`);
    exit(1);
  }

  // StreamableHTTPClientTransport only ever invokes onclose from its own
  // close() method (see the SDK source) -- it does NOT call onclose when a
  // POST fails or the server vanishes out from under it, even though that
  // is exactly the "daemon died" case this shim needs to recover from. Real
  // daemon death instead surfaces as onerror (every failed send() calls
  // onerror right before rejecting). So this is triggered from both onclose
  // (kept for correctness/defensiveness, and in case a future SDK version or
  // a different transport does close proactively) and onerror (the signal
  // that actually fires in practice today), guarded so overlapping failures
  // only ever start one reconnect attempt at a time.
  function triggerReconnect(reason: string): void {
    if (reconnecting || shuttingDown) {
      return;
    }
    reconnecting = true;
    log(`starting reconnect after: ${reason}`);
    void reconnectToDaemon().finally(() => {
      reconnecting = false;
    });
  }

  // Both directions of the bridge are plain transport-to-transport forwarding:
  // MCP messages (requests, responses, and server-initiated notifications
  // like notifications/resources/updated alike) are opaque JSON-RPC to both
  // transports, so relaying them verbatim is enough -- no MCP-level parsing
  // needed on top.
  function wireHttpTransport(transport: Transport): void {
    transport.onmessage = (message) => {
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
        if (message.id !== undefined) {
          const resolveReplay = pendingReplays.get(message.id);
          if (resolveReplay) {
            pendingReplays.delete(message.id);
            resolveReplay(message);
            return;
          }
          pending.delete(message.id);
        }
      }
      void stdioTransport.send(message).catch((err) => {
        log(`failed to forward a message to the stdio client: ${err instanceof Error ? err.message : String(err)}`);
      });
    };

    transport.onerror = (err) => {
      // A transport-level error here does not mean every in-flight request
      // failed -- it can be a single failed POST for one request, or a
      // background SSE reconnect attempt failing while every other request
      // is still fine. That specific request (if any) is failed individually
      // at its own send() rejection, not swept here -- sweeping every
      // pending id here used to answer a request TWICE (once with this
      // sweep's ConnectionClosed, once more with its real response that
      // still arrived afterward), which the SDK reports as "response for an
      // unknown message ID". What this DOES mean, reliably, is that the
      // daemon may be unreachable, so it starts the bounded reconnect
      // attempt (a no-op if one is already running).
      log(`daemon connection error: ${err.message}`);
      // A request that was already in flight against a transport this shim
      // has since replaced (reconnectToDaemon() swaps httpTransport, then
      // closes the old one) can still reject afterward. Ignore that: acting
      // on it would start a second, untracked reconnect after the first one
      // already succeeded, spawning a daemon nothing in this shim goes on
      // to track or clean up.
      if (transport === httpTransport) {
        triggerReconnect(err.message);
      }
    };

    transport.onclose = () => {
      // The daemon outlives its clients by design. This firing while we are
      // NOT already shutting down means the daemon connection dropped
      // unexpectedly mid-session, not that the stdio client went away.
      if (shuttingDown || transport !== httpTransport) {
        return;
      }
      log("daemon connection closed unexpectedly");
      failPendingRequests("connection closed");
      triggerReconnect("connection closed");
    };
  }

  stdioTransport.onmessage = (message) => {
    if (isJSONRPCRequest(message)) {
      pending.add(message.id);
      if (isInitializeRequest(message)) {
        cachedInitialize = message;
      }
    } else if (isInitializedNotification(message)) {
      cachedInitializedNotification = message;
    }
    void httpTransport.send(message).catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      log(`failed to forward a message to the daemon: ${reason}`);
      if (isJSONRPCRequest(message)) {
        failOneRequest(message.id, reason);
      }
    });
  };

  stdioTransport.onerror = (err) => {
    log(`stdio transport error: ${err.message}`);
  };

  const daemon = await options.ensureDaemon();
  log(`using daemon at ${daemon.url} (started here: ${daemon.started})`);
  httpTransport = options.makeHttpTransport(daemon);
  wireHttpTransport(httpTransport);

  await httpTransport.start();
  await stdioTransport.start();

  // StdioServerTransport only closes when told to; it does not watch stdin
  // for EOF itself. Watch it here: EOF means the stdio client (the MCP
  // host) went away, and the shim must exit cleanly WITHOUT stopping the
  // daemon -- it is shared with every other client on the machine.
  stdin.on("end", () => {
    shuttingDown = true;
    log("stdio client disconnected; shutting down (the daemon keeps running)");
    void httpTransport.close();
    void stdioTransport.close().finally(() => exit(0));
  });
}

export async function main(): Promise<void> {
  const stdioTransport = new StdioServerTransport();
  await runShim({
    stdioTransport,
    ensureDaemon: () => ensureDaemon(),
    makeHttpTransport: (daemon) =>
      new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${daemon.token}` } },
      }),
  });
}

// Runs main() only when this file is executed directly as a program (a
// stdio-only MCP host spawning `node dist/shim/index.js`), never merely
// imported -- a test importing runShim, or a future CLI importing this
// module to call something else out of it, must not spawn a daemon and
// seize this process's stdin as a side effect of the import. process.argv[1]
// can be undefined (e.g. `node -e`); treat that as "not the entrypoint"
// rather than throwing on the pathToFileURL() call below.
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((err) => {
    logDiagnostic(`shim failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
}
