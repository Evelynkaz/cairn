// Exercises the daemon as a real HTTP server: real MCP clients over
// StreamableHTTPClientTransport, real fetch requests for the security
// checks. Calling handlers directly would skip exactly the transport,
// Origin and auth wiring this module exists to get right.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTempDir, tempDbPath } from "../testing/tmp.js";
import { knn, listVectorSpaces, memorySeqsMissingVectors } from "../storage/index.js";
import { createFakeProvider } from "../embeddings/fake.js";
import { startDaemon } from "./server.js";
import type { DaemonHandle, DaemonOptions } from "./server.js";
import { readRuntimeFile, writeRuntimeFile } from "./runtime-file.js";

interface RememberResult {
  id: string;
  deduped: boolean;
  episodeId: string;
}

interface RecallHit {
  id: string;
  text: string;
}

interface RecallResult {
  hits: RecallHit[];
}

// The daemon always resolves the runtime file location from CAIRN_HOME
// (there is no override in DaemonOptions -- the real daemon has exactly one
// home). Point it at a fresh temp directory for the duration of each test so
// these never read or clobber the developer's real ~/.cairn/daemon.json.
async function withTempCairnHome<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = makeTempDir();
  const originalHome = process.env.CAIRN_HOME;
  process.env.CAIRN_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (originalHome === undefined) {
      delete process.env.CAIRN_HOME;
    } else {
      process.env.CAIRN_HOME = originalHome;
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Best-effort: never mask the real failure from fn() with a cleanup error.
    }
  }
}

// embeddings: "off" by default -- most of these tests have nothing to do
// with semantic search, and letting them resolve real embedding config
// would make every one of them open an extra bootstrap db connection for
// no reason. Tests that DO exercise embeddings pass their own override.
async function withDaemon<T>(
  fn: (handle: DaemonHandle, dir: string) => Promise<T>,
  extraOptions: Partial<DaemonOptions> = {},
): Promise<T> {
  return withTempCairnHome(async (dir) => {
    // port: 0 (ephemeral) everywhere -- a fixed port makes these flaky
    // whenever a real daemon is already running on the developer's machine.
    const handle = await startDaemon({ port: 0, dbPath: tempDbPath(dir), embeddings: "off", ...extraOptions });
    try {
      return await fn(handle, dir);
    } finally {
      await handle.close();
    }
  });
}

// StreamableHTTPClientTransport sends its requests over Node's global
// fetch(), whose keep-alive connection pool is owned by undici's global
// dispatcher -- there is no public API to close it, only this well-known
// internal symbol. Closing it is what lets this file's own worker process
// exit on its own (see CONTRIBUTING.md); it is a no-op if a future Node
// stops exposing the symbol, rather than a hard failure.
async function closeGlobalFetchDispatcher(): Promise<void> {
  const globalAny = globalThis as unknown as Record<symbol, { close?: () => Promise<void> } | undefined>;
  const dispatcher = globalAny[Symbol.for("undici.globalDispatcher.1")];
  await dispatcher?.close?.();
}

after(async () => {
  await closeGlobalFetchDispatcher();
});

// fetch()'s URL parsing collapses ".." dot-segments before the request ever
// leaves the process, so it cannot exercise the traversal guard over the
// wire -- node:http's request(), given a literal `path`, sends it verbatim.
function rawGet(handle: DaemonHandle, path: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: handle.host, port: handle.port, path, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end();
  });
}

function connectClient(handle: DaemonHandle, name = "daemon-test-client"): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${handle.token}` } },
  });
  const client = new Client({ name, version: "1.0.0" });
  return { client, transport };
}

async function callJson<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (!("content" in result) || !Array.isArray(result.content)) {
    throw new Error(`tool ${name} returned no content array`);
  }
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error(`tool ${name} returned no text content`);
  }
  if (result.isError === true) {
    throw new Error(`tool ${name} returned an error: ${first.text}`);
  }
  return JSON.parse(first.text) as T;
}

test("the daemon starts, /health reports ok and a live memory count, and the runtime file matches", async () => {
  await withDaemon(async (handle) => {
    async function health(): Promise<{ ok: boolean; version: string; uptimeMs: number; memories: number; vectors: boolean }> {
      const res = await fetch(`${handle.url}/health`);
      assert.equal(res.status, 200);
      return (await res.json()) as { ok: boolean; version: string; uptimeMs: number; memories: number; vectors: boolean };
    }

    const before = await health();
    assert.equal(before.ok, true);
    assert.equal(before.memories, 0);
    assert.equal(typeof before.uptimeMs, "number");
    assert.equal(typeof before.vectors, "boolean");

    // The count must be observed to actually change, not just be zero at
    // startup -- store.countMemories() is what /health calls (server.ts),
    // and this is what proves that wiring, not a hardcoded value.
    const { client, transport } = connectClient(handle);
    await client.connect(transport);
    try {
      await callJson<RememberResult>(client, "remember", { content: "health count sanity check" });
    } finally {
      await client.close();
    }
    const after = await health();
    assert.equal(after.memories, 1);

    const info = readRuntimeFile();
    assert.ok(info);
    assert.equal(info?.pid, process.pid);
    assert.equal(info?.port, handle.port);
    assert.equal(info?.token, handle.token);
  });
});

test("a real MCP client connects over Streamable HTTP, lists six tools, remembers and recalls", async () => {
  await withDaemon(async (handle) => {
    const { client, transport } = connectClient(handle);
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 6);

      const remembered = await callJson<RememberResult>(client, "remember", { content: "Daemon transport check." });
      assert.ok(remembered.id);

      const recalled = await callJson<RecallResult>(client, "recall", { query: "transport check" });
      assert.ok(recalled.hits.some((h) => h.id === remembered.id));
    } finally {
      await client.close();
    }
  });
});

test("two separate MCP clients connected at once share one store", async () => {
  await withDaemon(async (handle) => {
    const a = connectClient(handle, "client-a");
    const b = connectClient(handle, "client-b");
    await a.client.connect(a.transport);
    await b.client.connect(b.transport);
    try {
      const remembered = await callJson<RememberResult>(a.client, "remember", { content: "Shared across daemon clients." });
      const recalled = await callJson<RecallResult>(b.client, "recall", { query: "shared across daemon clients" });
      assert.ok(recalled.hits.some((h) => h.id === remembered.id), "client B must see what client A remembered");
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });
});

test("Origin enforcement: a foreign Origin is rejected, loopback and absent Origin are allowed", async () => {
  await withDaemon(async (handle) => {
    const evil = await fetch(`${handle.url}/health`, { headers: { Origin: "https://evil.example" } });
    assert.equal(evil.status, 403);

    const loopback = await fetch(`${handle.url}/health`, { headers: { Origin: "http://localhost:1234" } });
    assert.equal(loopback.status, 200);

    const none = await fetch(`${handle.url}/health`);
    assert.equal(none.status, 200);
  });
});

test("Origin enforcement accepts a bracketed IPv6 loopback Origin", async () => {
  await withDaemon(async (handle) => {
    // new URL("http://[::1]:3000").hostname === "[::1]" (brackets kept) --
    // a check comparing against bare "::1" only is dead code for this case.
    const res = await fetch(`${handle.url}/health`, { headers: { Origin: "http://[::1]:3000" } });
    assert.equal(res.status, 200);
  });
});

test("Origin enforcement near-misses: subdomain/prefix confusables are rejected, case and a literal 'null' Origin are handled correctly", async () => {
  await withDaemon(async (handle) => {
    // The classic bug this guards against: a check written as
    // origin.startsWith("http://localhost") (or 127.0.0.1) would let a
    // hostile domain sharing that PREFIX through -- exact hostname equality
    // must not.
    const localhostSubdomain = await fetch(`${handle.url}/health`, {
      headers: { Origin: "http://localhost.evil.com" },
    });
    assert.equal(localhostSubdomain.status, 403);

    const loopbackSubdomain = await fetch(`${handle.url}/health`, {
      headers: { Origin: "http://127.0.0.1.evil.com" },
    });
    assert.equal(loopbackSubdomain.status, 403);

    // Browsers send the literal string "null" as Origin for an opaque
    // origin (e.g. a sandboxed iframe or a local file) -- it must fail the
    // same as any other foreign origin, not be special-cased through.
    const nullOrigin = await fetch(`${handle.url}/health`, { headers: { Origin: "null" } });
    assert.equal(nullOrigin.status, 403);

    // A URL's hostname is lowercased on parse, so scheme/host casing must
    // not change the verdict for a genuinely local origin.
    const upperCaseLoopback = await fetch(`${handle.url}/health`, { headers: { Origin: "HTTP://LOCALHOST" } });
    assert.equal(upperCaseLoopback.status, 200);
  });
});

test("token enforcement: missing or wrong token is rejected with 401 and the body never carries the token", async () => {
  await withDaemon(async (handle) => {
    // No Authorization header at all -- the "missing token" case.
    const bareTransport = new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`));
    const bareClient = new Client({ name: "no-auth", version: "1.0.0" });
    await assert.rejects(
      () => bareClient.connect(bareTransport),
      (err: unknown) => {
        assert.ok(err instanceof StreamableHTTPError);
        assert.equal(err.code, 401);
        assert.ok(!(err.message ?? "").includes(handle.token), "401 body must not contain the bearer token");
        return true;
      },
    );

    // A wrong token -- distinct from missing, both must be rejected.
    const wrongTransport = new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer wrong-token-value" } },
    });
    const wrongClient = new Client({ name: "wrong-auth", version: "1.0.0" });
    await assert.rejects(
      () => wrongClient.connect(wrongTransport),
      (err: unknown) => {
        assert.ok(err instanceof StreamableHTTPError);
        assert.equal(err.code, 401);
        assert.ok(!(err.message ?? "").includes(handle.token), "401 body must not contain the bearer token");
        return true;
      },
    );

    const { client, transport } = connectClient(handle, "correct-auth");
    await client.connect(transport);
    await client.close();
  });
});

test("an unknown Mcp-Session-Id gets 404 with a JSON-RPC 'Session not found' error; a non-initialize POST with none at all gets 400", async () => {
  await withDaemon(async (handle) => {
    const unknownSessionRes = await fetch(`${handle.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.token}`,
        "Content-Type": "application/json",
        "Mcp-Session-Id": "00000000-0000-0000-0000-000000000000",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(unknownSessionRes.status, 404);
    const unknownSessionBody = (await unknownSessionRes.json()) as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string };
    };
    assert.equal(unknownSessionBody.error.code, -32001);
    assert.equal(unknownSessionBody.error.message, "Session not found");
    assert.equal(unknownSessionBody.id, null);

    const noSessionRes = await fetch(`${handle.url}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${handle.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(noSessionRes.status, 400);
  });
});

test("a request body over the size cap is rejected with 413 before being parsed", async () => {
  await withDaemon(async (handle) => {
    const oversized = "x".repeat(5 * 1024 * 1024); // over MAX_REQUEST_BODY_BYTES (4 MiB)
    const res = await fetch(`${handle.url}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${handle.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { oversized } }),
    });
    assert.equal(res.status, 413);
  });
});

test("session eviction: a session idle past sessionIdleTimeoutMs is swept and its id stops being usable", async () => {
  await withDaemon(
    async (handle) => {
      const { client, transport } = connectClient(handle);
      await client.connect(transport);
      const sessionId = transport.sessionId;
      assert.ok(sessionId);

      // Deliberately not calling client.close(): the whole point of this
      // fix is that a client which vanishes WITHOUT sending DELETE (which
      // is exactly what StreamableHTTPClientTransport.close() does) must
      // still have its session reclaimed, on a timer, not held forever.

      // Longer than sessionIdleTimeoutMs + sessionSweepIntervalMs below.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const res = await fetch(`${handle.url}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.token}`,
          "Content-Type": "application/json",
          "Mcp-Session-Id": sessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(res.status, 404, "an evicted session must read back as unknown (404), not still live");
    },
    { sessionIdleTimeoutMs: 30, sessionSweepIntervalMs: 20 },
  );
});

test("session cap: a new initialize past maxSessions is rejected while existing sessions keep working", async () => {
  await withDaemon(
    async (handle) => {
      const first = connectClient(handle, "cap-client-a");
      await first.client.connect(first.transport);
      try {
        const second = connectClient(handle, "cap-client-b");
        await assert.rejects(() => second.client.connect(second.transport));

        // The session already established must be unaffected by the cap.
        const { tools } = await first.client.listTools();
        assert.ok(tools.length > 0);
      } finally {
        await first.client.close();
      }
    },
    { maxSessions: 1 },
  );
});

test("/health needs no token; an unknown path returns 404; /ui responds", async () => {
  await withDaemon(async (handle) => {
    const health = await fetch(`${handle.url}/health`);
    assert.equal(health.status, 200);

    const missing = await fetch(`${handle.url}/nope`);
    assert.equal(missing.status, 404);

    const ui = await fetch(`${handle.url}/ui`);
    assert.equal(ui.status, 200);

    const uiSub = await fetch(`${handle.url}/ui/index.html`);
    assert.equal(uiSub.status, 200);
  });
});

test("GET /ui serves the real built dashboard with its security headers", async () => {
  await withDaemon(async (handle) => {
    const res = await fetch(`${handle.url}/ui`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.ok(res.headers.get("content-security-policy"));
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const body = await res.text();
    assert.match(body, /<div id="app">/);
  });
});

test("GET /ui/styles.css serves the built stylesheet", async () => {
  await withDaemon(async (handle) => {
    const res = await fetch(`${handle.url}/ui/styles.css`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/css; charset=utf-8");
  });
});

test("GET /ui/../../package.json is rejected by the real daemon, not only the unit test", async () => {
  await withDaemon(async (handle) => {
    const res = await rawGet(handle, "/ui/../../package.json");
    assert.equal(res.status, 403);
  });
});

test("/api requires the daemon's bearer token, and an unknown /api path 404s once authorized", async () => {
  await withDaemon(async (handle) => {
    const noToken = await fetch(`${handle.url}/api/stats`);
    assert.equal(noToken.status, 401);

    const withToken = await fetch(`${handle.url}/api/stats`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    assert.equal(withToken.status, 200);
    const body = (await withToken.json()) as { liveMemories: number };
    assert.equal(typeof body.liveMemories, "number");

    const unknown = await fetch(`${handle.url}/api/nope`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    assert.equal(unknown.status, 404);
  });
});

test("Origin enforcement covers /api too: a foreign Origin is rejected before the route is reached", async () => {
  await withDaemon(async (handle) => {
    const res = await fetch(`${handle.url}/api/stats`, {
      headers: { Authorization: `Bearer ${handle.token}`, Origin: "http://evil.example" },
    });
    assert.equal(res.status, 403);
  });
});

test("close() ends an open SSE stream instead of hanging", async () => {
  await withTempCairnHome(async (dir) => {
    const handle = await startDaemon({ port: 0, dbPath: tempDbPath(dir), embeddings: "off" });
    const stream = await fetch(`${handle.url}/api/events`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    assert.equal(stream.status, 200);
    await handle.close();
    // No assertion beyond resolving: a stream left open here would hang
    // the whole suite (npm test runs without --test-force-exit).
  });
});

test("close() removes the runtime file and the port stops accepting connections", async () => {
  await withTempCairnHome(async (dir) => {
    const handle = await startDaemon({ port: 0, dbPath: tempDbPath(dir), embeddings: "off" });
    const port = handle.port;
    await handle.close();

    assert.equal(readRuntimeFile(), null);
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/health`));
  });
});

test("a second daemon refuses to start when the runtime file already names a live daemon on a different port", async () => {
  await withTempCairnHome(async (dir) => {
    const first = await startDaemon({ port: 0, dbPath: tempDbPath(dir), embeddings: "off" });
    try {
      await assert.rejects(
        () => startDaemon({ port: 0, dbPath: tempDbPath(dir), embeddings: "off" }),
        /already running/,
      );

      // The first daemon's runtime file (and its port) must be untouched.
      const info = readRuntimeFile();
      assert.ok(info);
      assert.equal(info?.port, first.port);
      const stillUp = await fetch(`${first.url}/health`);
      assert.equal(stillUp.status, 200);
    } finally {
      await first.close();
    }
  });
});

test("two startDaemon calls racing on the SAME fixed port: the loser rejects EADDRINUSE-shaped and never touches its database file", async () => {
  await withTempCairnHome(async (home) => {
    // Distinct dbPaths (each nonexistent until touched), both under the
    // one CAIRN_HOME, so, whichever of the two loses the port, its own
    // database file staying absent proves that loser's startDaemon() call
    // never reached openDb() -- the whole point of claiming the port
    // before touching the database.
    const pathA = tempDbPath(makeTempDir());
    const pathB = tempDbPath(makeTempDir());
    const port = 34567 + Math.floor(Math.random() * 5000);

    const [resultA, resultB] = await Promise.allSettled([
      startDaemon({ port, dbPath: pathA, embeddings: "off" }),
      startDaemon({ port, dbPath: pathB, embeddings: "off" }),
    ]);

    const results = [
      { result: resultA, path: pathA },
      { result: resultB, path: pathB },
    ];
    const winners = results.filter((r) => r.result.status === "fulfilled");
    const losers = results.filter((r) => r.result.status === "rejected");

    assert.equal(winners.length, 1, "exactly one racer should win the port");
    assert.equal(losers.length, 1, "exactly one racer should lose the port");

    const loser = losers[0]!.result as PromiseRejectedResult;
    const errorMessage = loser.reason instanceof Error ? loser.reason.message : String(loser.reason);
    assert.match(errorMessage, /EADDRINUSE|address (is )?already in use/i);

    // The loser must never have created (let alone migrated) its own
    // database file: it failed on the port before ever calling openDb().
    assert.equal(existsSync(losers[0]!.path), false);
    assert.equal(existsSync(winners[0]!.path), true);

    const winnerHandle = (winners[0]!.result as PromiseFulfilledResult<DaemonHandle>).value;
    await winnerHandle.close();
  });
});

test("close() does not remove the runtime file once it no longer names this daemon's own pid", async () => {
  await withTempCairnHome(async (dir) => {
    const handle = await startDaemon({ port: 0, dbPath: tempDbPath(dir), embeddings: "off" });
    // Simulate a second, real (out-of-process, different pid) daemon having
    // since taken over daemon.json -- every daemon started within this test
    // process shares process.pid, so a real takeover has to be faked here.
    const takeoverPid = process.pid + 1;
    writeRuntimeFile({ pid: takeoverPid, port: handle.port + 1, token: "other-daemon-token", startedAt: Date.now(), version: "9.9.9" });

    await handle.close();

    const info = readRuntimeFile();
    assert.ok(info, "close() must not remove a runtime file naming a different pid");
    assert.equal(info?.pid, takeoverPid);
  });
});

test("embeddings: 'auto' with a forced fake provider makes a remembered memory vector-searchable once the indexer drains", async () => {
  const fake = createFakeProvider();
  await withDaemon(
    async (handle) => {
      assert.equal(handle.provider, fake);
      assert.ok(handle.space);
      const space = handle.space;
      if (!space) throw new Error("expected a vector space to have been created");

      const { client, transport } = connectClient(handle);
      await client.connect(transport);
      let memoryId: string;
      try {
        const text = "Semantic embedding sanity check about kangaroos.";
        const remembered = await callJson<RememberResult>(client, "remember", { content: text });
        memoryId = remembered.id;
      } finally {
        await client.close();
      }

      const seqRow = handle.store.db.q("select seq from memories where id = ?").get(memoryId);
      const seq = Number(seqRow?.["seq"]);
      assert.ok(Number.isFinite(seq));

      // The daemon runs the indexer in the background (BUILD_BRIEF §2:
      // remember() itself never waits on a model) -- poll for it to drain
      // rather than assuming any fixed delay.
      const deadline = Date.now() + 5000;
      let missing = memorySeqsMissingVectors(handle.store.db, space, 10);
      while (missing.includes(seq) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        missing = memorySeqsMissingVectors(handle.store.db, space, 10);
      }
      assert.ok(!missing.includes(seq), "the daemon's indexer never embedded the remembered memory");

      const [queryVector] = await fake.embed(["Semantic embedding sanity check about kangaroos."]);
      assert.ok(queryVector);
      const hits = knn(handle.store.db, space, queryVector, { k: 1 });
      assert.ok(hits.some((hit) => hit.memorySeq === seq), "the memory must be findable by vector KNN");
    },
    { embeddings: "auto", provider: fake },
  );
});

test("embeddings: 'off' never creates a vector space, and remember/recall (FTS-only) still work", async () => {
  await withDaemon(async (handle) => {
    assert.equal(handle.provider, null);
    assert.equal(handle.space, null);

    const { client, transport } = connectClient(handle);
    await client.connect(transport);
    try {
      const remembered = await callJson<RememberResult>(client, "remember", { content: "FTS-only mode check." });
      const recalled = await callJson<RecallResult>(client, "recall", { query: "FTS-only mode check" });
      assert.ok(recalled.hits.some((h) => h.id === remembered.id));
    } finally {
      await client.close();
    }

    assert.deepEqual(listVectorSpaces(handle.store.db), []);
  });
});
