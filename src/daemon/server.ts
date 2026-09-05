// The Cairn daemon (BUILD_BRIEF §4): the single background process that
// owns the WAL-mode SQLite store and serves MCP over Streamable HTTP, so
// every client on the machine (Claude Desktop, Claude Code, Cursor, ...)
// shares one memory store instead of each client keeping its own copy.
// This module only wires transport/security; retrieval, embeddings and the
// tool surface itself live in ../mcp and ../storage and are used as-is.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../mcp/server.js";
import type { McpDeps } from "../mcp/deps.js";
import { MemoryEventBus } from "../mcp/events.js";
import { openStore, ensureVectorSpace } from "../storage/index.js";
import type { Store, VectorSpaceRef } from "../storage/index.js";
import { serveUiFile } from "../dashboard/assets.js";
import { createDashboardApi } from "../dashboard/api.js";
import type { DashboardApi } from "../dashboard/api.js";
import { openDb } from "../storage/db.js";
import { resolveEmbeddingConfig, describeConfig } from "../embeddings/registry.js";
import { createProviderFromConfig } from "../embeddings/factory.js";
import { createIndexer } from "../embeddings/worker.js";
import type { Indexer } from "../embeddings/worker.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import {
  generateToken,
  isDaemonAlive,
  readRuntimeFile,
  removeRuntimeFile,
  runtimeFilePath,
  writeRuntimeFile,
} from "./runtime-file.js";
import { MAX_REQUEST_BODY_BYTES, PayloadTooLargeError, readJsonBody, sendJson, tokenMatches } from "./http.js";

export const DEFAULT_PORT = 8787;
const DAEMON_VERSION = "0.1.0";

// A client that closes without sending DELETE (StreamableHTTPClientTransport
// .close() does not) leaks its session forever without this: evict any
// session idle past this long, and cap how many can accumulate in between.
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 1000;

// Loopback-only, deliberately, and never configurable to anything wider:
// binding 0.0.0.0 (or any other interface) would let any other device on
// the LAN reach a user's memory store, which fails local-first/privacy
// outright (BUILD_BRIEF §2). The accepted consequence is that every client
// -- the stdio->HTTP shim, the CLI, the dashboard -- must run on the same
// host as the daemon, which is true for every zero-config deployment this
// project targets.
const LOOPBACK_HOST = "127.0.0.1";

export interface DaemonOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  token?: string;
  store?: Store;
  // BUILD_BRIEF §2/§3: "auto" (the default) resolves the embedding config
  // from settings/env and, when it names a consented provider, builds it
  // and starts the background indexer; "off" skips all of that and runs
  // FTS-only, deterministically -- the escape hatch tests use so they never
  // depend on settings/env state or a real model/network call. Ignored
  // entirely when `store` is supplied: a caller-owned store already made
  // its own retrieval choice via StoreOptions.
  embeddings?: "auto" | "off";
  // Test-only escape hatch: use this exact provider instead of resolving
  // one via resolveEmbeddingConfig/createProviderFromConfig, which would
  // try to load a real local model or reach a real HTTP API. Lets a test
  // exercise the daemon's embedding wiring end-to-end with the
  // deterministic `fake` provider (../embeddings/fake.js). Only consulted
  // when embeddings is "auto" (the default) and no `store` was supplied.
  provider?: EmbeddingProvider;
  // Session-leak controls (see the eviction/cap comment on `sessions`
  // below). Defaults are production values; tests inject short ones so
  // eviction/cap tests never wait real minutes.
  sessionIdleTimeoutMs?: number;
  sessionSweepIntervalMs?: number;
  maxSessions?: number;
  // Test-only escape hatch: the /health memory count is memoized behind
  // this TTL (production default a few seconds -- see the comment on
  // countMemoriesCached below); a test asserting the count changed right
  // after a write sets this to 0 so it observes the real value every time.
  healthMemoryCountTtlMs?: number;
  // Test-only escape hatch: lets a test give the dashboard API (stats'
  // recency math, in particular) a deterministic clock instead of the real
  // Date.now, the same reason sessionIdleTimeoutMs etc. exist above.
  now?: () => number;
}

export interface DaemonHandle {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  readonly token: string;
  readonly store: Store;
  readonly provider: EmbeddingProvider | null;
  readonly space: VectorSpaceRef | null;
  close(): Promise<void>;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    // A URL's hostname keeps the brackets for a literal IPv6 address (e.g.
    // "http://[::1]:3000" parses to hostname "[::1]", not "::1"), so both
    // forms must be accepted here or an IPv6-loopback Origin is rejected by
    // dead code -- isLoopbackHost (bind-side) already accepts bare "::1".
    return (
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

// DNS-rebinding closes only halfway with the Origin check above: after a
// rebind, the attacker's page is same-origin with the daemon, so its
// requests carry no Origin header at all (a real MCP client sends none
// either, which is why Origin absence is allowed) and sail past it. Host is
// the second half -- a rebound page's Host header still names the attacker's
// domain, not this loopback address, so requiring it to be one of the
// addresses the daemon actually bound closes the gap the Origin check alone
// cannot.
function isAllowedHost(hostHeader: string, port: number): boolean {
  const host = hostHeader.toLowerCase();
  return (
    host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    host === `[::1]:${port}` ||
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "[::1]"
  );
}

function resolvePort(explicit: number | undefined): number {
  if (explicit !== undefined) {
    return explicit;
  }
  const envValue = process.env.CAIRN_PORT;
  if (envValue) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return DEFAULT_PORT;
}

export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const host = options.host ?? LOOPBACK_HOST;
  if (!isLoopbackHost(host)) {
    throw new Error(`the daemon may only bind a loopback host, got "${host}"`);
  }
  const port = resolvePort(options.port);

  // Ownership: a store this function opens, it closes on shutdown. A store
  // the caller passed in belongs to the caller (e.g. a test sharing one
  // store across two daemon instances, or a future in-process embedding) --
  // close() must never reach for it.
  const ownsStore = options.store === undefined;
  const ownsProvider = options.provider === undefined;

  const token = options.token ?? generateToken();
  const startedAt = Date.now();
  const sessions = new Map<string, SessionEntry>();
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
  const sessionSweepIntervalMs = options.sessionSweepIntervalMs ?? DEFAULT_SESSION_SWEEP_INTERVAL_MS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;

  // §4: two clients (Claude Desktop, Claude Code) can launch together and
  // both reach startDaemon() at once. On a fixed port, the port itself is
  // the real arbiter of who wins that race -- exactly one process can
  // listen() it -- so it must be claimed BEFORE this function ever opens
  // the database file; opening the DB first (the previous order) let both
  // processes start fighting over the file before either had lost. `ready`
  // is filled in only once the store has actually been opened and
  // migrated; a request that lands in the window between listen() and that
  // (real, not hypothetical -- however long openStore() takes) gets an
  // honest 503 below rather than a 404 (reads as "wrong URL") or a hang.
  interface ReadyState {
    store: Store;
    deps: McpDeps;
    api: DashboardApi;
  }
  let ready: ReadyState | null = null;

  function sendNotReady(res: ServerResponse): void {
    sendJson(res, 503, { error: "daemon is still starting" });
  }

  function hasValidToken(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    const prefix = "Bearer ";
    const provided = typeof header === "string" && header.startsWith(prefix) ? header.slice(prefix.length) : null;
    return provided !== null && tokenMatches(provided, token);
  }

  // /health is reachable with no Origin at all from an ordinary web page
  // (an <img> tag sends none), so an unauthenticated hit must never trigger
  // a real table scan -- memoize countMemories() for a few seconds behind a
  // timestamp comparison, not a timer (a timer here would be one more thing
  // close() must remember to clear, and CONTRIBUTING.md forbids
  // --test-force-exit).
  const healthMemoryCountTtlMs = options.healthMemoryCountTtlMs ?? 5000;
  let cachedMemoryCount: number | null = null;
  let cachedMemoryCountAt = 0;

  function countMemoriesCached(store: Store): number {
    const now = Date.now();
    if (cachedMemoryCount === null || now - cachedMemoryCountAt > healthMemoryCountTtlMs) {
      cachedMemoryCount = store.countMemories();
      cachedMemoryCountAt = now;
    }
    return cachedMemoryCount;
  }

  function handleHealth(req: IncomingMessage, res: ServerResponse): void {
    if (!ready) {
      // A health check that lies about readiness is worse than one that
      // says "not yet" -- never report ok:true before the store is real.
      sendNotReady(res);
      return;
    }
    // No auth REQUIRED on this route by design: it must be usable to detect
    // a live daemon before the caller has read the bearer token off disk.
    // But an unauthenticated hit must leak nothing beyond these fields -- no
    // memory content, no token, no paths, and (see below) no memory count,
    // which is itself sensitive and otherwise driveable at will by any page
    // the user has open.
    const body: Record<string, unknown> = {
      ok: true,
      pid: process.pid,
      version: DAEMON_VERSION,
      uptimeMs: Date.now() - startedAt,
      vectors: ready.store.capabilities.vectors,
      journalMode: ready.store.capabilities.journalMode,
    };
    if (hasValidToken(req)) {
      body.memories = countMemoriesCached(ready.store);
    }
    sendJson(res, 200, body);
  }

  function authorizeMcp(req: IncomingMessage, res: ServerResponse): boolean {
    if (!hasValidToken(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return false;
    }
    return true;
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!ready) {
      sendNotReady(res);
      return;
    }
    const deps = ready.deps;

    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      // MAX_REQUEST_BODY_BYTES only bounds readJsonBody, below, on the
      // *initialize* path -- once a session exists, handleRequest hands the
      // socket straight to the SDK's own transport, which reads the whole
      // body itself with no limit of its own. One request from a
      // compromised client could otherwise OOM the daemon every client on
      // the machine shares. Content-Length is checked first (cheap, and
      // catches the common case before a single byte is read), but it can
      // be absent on a chunked upload, so a running byte counter backs it up
      // and destroys the socket if the real body outgrows the cap regardless
      // of what the client claimed.
      const contentLengthHeader = req.headers["content-length"];
      if (contentLengthHeader !== undefined && Number(contentLengthHeader) > MAX_REQUEST_BODY_BYTES) {
        sendJson(res, 413, { error: "request body too large" });
        return;
      }
      let bytesRead = 0;
      const enforceBodyCap = (chunk: Buffer): void => {
        bytesRead += chunk.length;
        if (bytesRead > MAX_REQUEST_BODY_BYTES) {
          req.destroy();
        }
      };
      req.on("data", enforceBodyCap);
      // Resuming (or terminating, on DELETE) an established session: the
      // SDK's own session handling takes it from here. Touching lastSeen on
      // every handled request (not just at creation) is what makes the idle
      // eviction sweep below measure actual idleness, not session age.
      existing.lastSeen = Date.now();
      try {
        await existing.transport.handleRequest(req, res);
      } finally {
        req.off("data", enforceBodyCap);
      }
      return;
    }

    // A session id was supplied but is not (or no longer) known -- MCP
    // mandates 404 with -32001 "Session not found" here (matching the SDK's
    // own transport), which is the client's signal to re-initialize rather
    // than a hard failure it cannot recover from -- e.g. a client that
    // outlives a daemon restart. 400 is reserved below for a non-initialize
    // POST that supplies no session id at all.
    if (sessionId !== undefined) {
      sendJson(res, 404, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "Session not found" },
      });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 400, { error: "missing or unknown Mcp-Session-Id" });
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = await readJsonBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: "request body too large" });
        return;
      }
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    if (!isInitializeRequest(parsedBody)) {
      sendJson(res, 400, { error: "missing or unknown Mcp-Session-Id" });
      return;
    }

    // A leaked-session cap: without it, a client that never sends DELETE
    // (StreamableHTTPClientTransport.close() does not) grows sessions --
    // and the whole McpServer/store each entry carries -- without bound
    // for the daemon's life, between eviction sweeps.
    if (sessions.size >= maxSessions) {
      sendJson(res, 503, { error: `too many active sessions (limit ${maxSessions}); try again later` });
      return;
    }

    // A fresh session: a new transport and a new McpServer instance, bound
    // to the *same* store -- this is what makes "one daemon, many clients"
    // true. entry is assigned before onsessioninitialized can possibly run.
    let entry: SessionEntry | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        if (entry) {
          sessions.set(sid, entry);
        }
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
      }
    };
    const mcpServer = createMcpServer(deps);
    entry = { transport, server: mcpServer, lastSeen: Date.now() };
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  }

  // Evicts any session idle past sessionIdleTimeoutMs -- the counterpart to
  // the cap above, for sessions that leaked in under it. unref()'d so a
  // running daemon this timer is the only thing keeping alive can still
  // exit; see the timer inside embeddings/worker.ts for the same pattern.
  const sessionEvictionTimer = setInterval(() => {
    void (async () => {
      const now = Date.now();
      for (const [sid, entry] of Array.from(sessions.entries())) {
        if (now - entry.lastSeen > sessionIdleTimeoutMs) {
          sessions.delete(sid);
          try {
            await entry.server.close();
          } catch {
            // Best-effort: an already-broken session's close() must not
            // crash the sweep or block evicting the rest.
          }
        }
      }
    })();
  }, sessionSweepIntervalMs);
  sessionEvictionTimer.unref();

  // Filled in once listen() below resolves; read by the Host check via
  // closure, never copied, so it reflects the port actually bound even when
  // `port` was 0 (ephemeral).
  let boundPort = port;

  const httpServer: HttpServer = createServer((req, res) => {
    void (async () => {
      try {
        const origin = req.headers.origin;
        // DNS-rebinding defence: without this check, any web page the user
        // has open in a browser tab can point a same-origin-exempt fetch at
        // 127.0.0.1 and drive this daemon using the visitor's own browser as
        // a proxy -- loopback binding alone does not stop that, because the
        // browser itself is already running on loopback's trusted side. A
        // real MCP client is not a browser and sends no Origin header at
        // all, so only a *present and foreign* Origin is rejected.
        if (origin !== undefined && !isLoopbackOrigin(origin)) {
          sendJson(res, 403, { error: "origin not allowed" });
          return;
        }

        // Second half of the DNS-rebinding defence: see isAllowedHost above.
        const hostHeader = req.headers.host;
        if (typeof hostHeader !== "string" || !isAllowedHost(hostHeader, boundPort)) {
          sendJson(res, 403, { error: "host not allowed" });
          return;
        }

        const url = new URL(req.url ?? "/", `http://${host}`);
        const pathname = url.pathname;

        if (pathname === "/health" && req.method === "GET") {
          handleHealth(req, res);
          return;
        }

        if (pathname === "/mcp") {
          if (!authorizeMcp(req, res)) {
            return;
          }
          await handleMcp(req, res);
          return;
        }

        // Unauthenticated by design: the HTML/CSS/JS served here are not
        // secrets -- they are the same bytes shipped in the npm package --
        // and the data they render is what the bearer token on /api
        // protects. Requiring a token here would only stop the browser from
        // ever loading the page that asks for one.
        //
        // Routed off the RAW request path, not the WHATWG-normalized
        // `pathname` above: `new URL()` silently collapses ".." segments
        // itself (e.g. "/ui/../../package.json" becomes "/package.json"),
        // which would route a traversal attempt to the 404 fallback instead
        // of ever reaching serveUiFile -- harmless, but it would mean the
        // traversal guard inside serveUiFile is only ever exercised by its
        // own unit test, never by a real request. Checking and serving off
        // the raw path keeps that guard load-bearing end-to-end.
        const rawPath = (req.url ?? "/").split("?", 1)[0] ?? "/";
        if (rawPath === "/ui" || rawPath.startsWith("/ui/")) {
          if (req.method !== "GET") {
            sendJson(res, 404, { error: "not found" });
            return;
          }
          const file = serveUiFile(rawPath);
          res.writeHead(file.status, file.headers);
          res.end(file.body);
          return;
        }

        if (pathname === "/api" || pathname.startsWith("/api/")) {
          if (!ready) {
            sendNotReady(res);
            return;
          }
          // No authorizeMcp() call here on purpose: createDashboardApi does
          // its own bearer check internally with the same tokenMatches, and
          // a second, differently-worded check here is exactly the
          // duplicated-predicate drift this repo already fixed once
          // (bd8f75b).
          const handled = await ready.api.handle(req, res, url);
          if (!handled) {
            sendJson(res, 404, { error: "not found" });
          }
          return;
        }

        sendJson(res, 404, { error: "not found" });
      } catch {
        // Never let a handler throw take the process down, and never log
        // the error -- it may embed a request body or memory content.
        if (!res.headersSent) {
          sendJson(res, 500, { error: "internal error" });
        }
      }
    })();
  });

  // Node's own defaults (60s headersTimeout, no requestTimeout cap, no
  // connection cap) are the only slowloris/flood bound otherwise, and an
  // unauthenticated local process could hold thousands of sockets against a
  // shared daemon. Chosen to still let a legitimate slow client through:
  //   - headersTimeout: Node's own default (60s) -- long enough for a
  //     loopback client on a loaded machine to finish sending headers, short
  //     enough to bound a client that trickles them on purpose.
  //   - requestTimeout: 10 minutes -- a large but legal import POST
  //     (export_memories/import_memories, §6) must be able to fully arrive
  //     even over a slow disk/CPU-bound JSON parse; an MCP tool call is
  //     otherwise done in milliseconds.
  //   - maxConnections: 256 -- no zero-config deployment this project
  //     targets holds anywhere near this many concurrent loopback
  //     connections (one or two per client: Claude Desktop, Claude Code,
  //     Cursor, one dashboard tab), so this only bites a connection flood.
  httpServer.headersTimeout = 60_000;
  httpServer.requestTimeout = 10 * 60_000;
  httpServer.maxConnections = 256;

  // Claim the port FIRST: on the fixed port production uses, this is what
  // decides who wins the two-clients-launch-together race (§4). A process
  // that loses fails here, with EADDRINUSE, having never opened the
  // database -- exactly the outcome ensure-daemon.ts's own race comment
  // assumes. The database is not touched until this resolves.
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  boundPort = actualPort;
  const url = `http://${host}:${actualPort}`;

  // BUILD_BRIEF §2/§3: resolve the embedding config and build a provider
  // BEFORE opening the store, so the store itself (not just McpDeps below)
  // is constructed with the resolved provider/space -- that is what makes
  // store.forgetWhere()'s own default query-shaped search vector-aware, not
  // only recall()/context() (which also take a per-call override). "off"
  // and a caller-supplied store both skip this entirely: a supplied store
  // already made its own retrieval choice via StoreOptions, and
  // re-resolving here would be a second, independently-drifting copy of it.
  let provider: EmbeddingProvider | null = null;
  let space: VectorSpaceRef | null = null;
  let store: Store;

  try {
    const embeddingsMode = options.embeddings ?? "auto";

    if (embeddingsMode === "auto" && ownsStore) {
      const bootstrapDb = openDb({ path: options.dbPath });
      try {
        if (options.provider !== undefined) {
          provider = options.provider;
        } else {
          const config = resolveEmbeddingConfig(bootstrapDb);
          try {
            provider = await createProviderFromConfig(config);
          } catch (error) {
            // A broken local runtime or an unreachable API must never keep
            // the daemon from starting -- an optional accelerator being down
            // is worse handled by refusing memory entirely than by degrading.
            const reason = error instanceof Error ? error.message : String(error);
            process.stderr.write(
              `cairn daemon: embedding provider "${config.provider}" failed to start (${reason}); continuing FTS-only\n`,
            );
            provider = null;
          }
          if (provider === null) {
            // §2: FTS-only is a supported mode, not an error -- say so once,
            // to stderr only (stdout is reserved for the MCP stdio protocol).
            process.stderr.write(`${describeConfig(config)}\n`);
          }
        }
        if (provider !== null) {
          space = ensureVectorSpace(bootstrapDb, provider.modelId, provider.dim);
        }
      } catch (error) {
        // Covers ensureVectorSpace (or a hand-supplied provider) failing for
        // a reason the narrower catch above doesn't -- same "never refuse to
        // start" rule applies.
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(`cairn daemon: semantic search unavailable (${reason}); continuing FTS-only\n`);
        provider = null;
        space = null;
      } finally {
        bootstrapDb.close();
      }
    }

    store = options.store ?? openStore({ path: options.dbPath, provider, space });
  } catch (error) {
    // The port is already held; if the database then fails to open, that
    // must not leave a daemon-shaped process squatting on it forever with
    // nothing behind it -- close the HTTP server before rejecting so a
    // retrying client (or the losing racer) can bind the port instead.
    clearInterval(sessionEvictionTimer);
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    throw error;
  }

  // ONE bus for the whole daemon, shared by every session's McpDeps below --
  // this is what lets a mutation on one client's session reach another
  // client's own subscription (see mcp/events.ts, mcp/server.ts).
  const bus = new MemoryEventBus();
  const deps: McpDeps = { store, provider, space, bus };
  // One instance for the whole daemon, not per request: it owns SSE
  // streams and heartbeat timers that must outlive any single request.
  const api = createDashboardApi({ store, token, bus, now: options.now });
  ready = { store, deps, api };

  // Drains the backlog in the background at whatever pace provider.embed()
  // sustains (BUILD_BRIEF §2: remember() itself never waits on a model).
  // Left null in FTS-only mode, or if the indexer itself fails to start
  // (e.g. capabilities.vectors is false) -- same graceful-degrade rule.
  let indexer: Indexer | null = null;
  if (provider !== null) {
    try {
      indexer = createIndexer(store.db, provider);
      indexer.start();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`cairn daemon: embedding indexer failed to start (${reason}); continuing FTS-only\n`);
      indexer = null;
    }
  }

  async function shutdownHttpAndStore(): Promise<void> {
    clearInterval(sessionEvictionTimer);
    httpServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    if (ownsStore) {
      store.close();
    }
  }

  // Refuse to clobber a still-live daemon's runtime file: daemon.json is
  // the ONLY way a client discovers a running daemon (BUILD_BRIEF §4), so
  // overwriting one that names a different, still-listening port would
  // make that daemon undiscoverable while it keeps holding its port -- and
  // deleting the file on THIS daemon's later close() would make it stay
  // undiscoverable even after this one exits. A daemon on the SAME port
  // never reaches this check: the listen() above already failed EADDRINUSE.
  const existingRuntime = readRuntimeFile();
  if (existingRuntime && existingRuntime.port !== actualPort && (await isDaemonAlive(existingRuntime))) {
    if (indexer) {
      await indexer.stop();
    }
    api.close();
    await shutdownHttpAndStore();
    if (ownsProvider && provider) {
      await provider.close();
    }
    throw new Error(
      `a Cairn daemon is already running (pid ${existingRuntime.pid}, port ${existingRuntime.port}); ` +
        `refusing to overwrite ${runtimeFilePath()}. Stop it first, or point this instance at a different CAIRN_HOME.`,
    );
  }

  writeRuntimeFile({ pid: process.pid, port: actualPort, token, startedAt, version: DAEMON_VERSION });

  async function close(): Promise<void> {
    if (indexer) {
      await indexer.stop();
    }
    // Every open SSE stream and heartbeat timer must be released here --
    // npm test runs without --test-force-exit, so a stream left open would
    // hang the whole suite, not just this daemon.
    api.close();
    for (const entry of Array.from(sessions.values())) {
      await entry.server.close();
    }
    sessions.clear();
    await shutdownHttpAndStore();
    if (ownsProvider && provider) {
      await provider.close();
    }
    // Only remove the runtime file if it still names THIS daemon: another
    // daemon may have started since (a stale file we lost the race on, or
    // -- in a test -- a fabricated takeover), and removing its entry would
    // make it undiscoverable while still holding its port.
    const currentRuntime = readRuntimeFile();
    if (currentRuntime && currentRuntime.pid === process.pid) {
      removeRuntimeFile();
    }
  }

  // SIGINT/SIGTERM handling is deliberately not installed here: this is a
  // library function, and a test (or any other in-process caller) that
  // imports it must never have its process signals hijacked as a side
  // effect of calling startDaemon(). The daemon's process entrypoint (the
  // future `cairn daemon` CLI command) owns the process and is responsible
  // for wiring `process.on("SIGINT"/"SIGTERM", () => handle.close()...)`
  // itself around this handle.

  return { port: actualPort, host, url, token, store, provider, space, close };
}
