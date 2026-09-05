// Exercises the dashboard API through a real node:http server wrapping
// `handle`, exactly like ../daemon/server.test.ts exercises the daemon --
// calling handlers directly would skip the parts (routing, headers,
// content-length) an integration bug is most likely to hide in.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { request } from "node:http";
import { makeTempDir, tempDbPath } from "../testing/tmp.js";
import { openStore } from "../storage/index.js";
import type { Store } from "../storage/index.js";
import { MemoryEventBus } from "../mcp/events.js";
import { createDashboardApi, DASHBOARD_CLIENT } from "./api.js";
import type { DashboardApi } from "./api.js";
import { createFakeProvider } from "../embeddings/fake.js";
import { ensureVectorSpace } from "../storage/repositories/vectors.js";

const TOKEN = "test-token-0123456789";

interface Ctx {
  dir: string;
  store: Store;
  bus: MemoryEventBus;
  api: DashboardApi;
  server: Server;
  baseUrl: string;
}

async function setup(): Promise<Ctx> {
  const dir = makeTempDir();
  const store = openStore({ path: tempDbPath(dir) });
  const bus = new MemoryEventBus();
  const api = createDashboardApi({ store, token: TOKEN, bus });
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const handled = await api.handle(req, res, url);
      if (!handled) {
        res.writeHead(404).end();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { dir, store, bus, api, server, baseUrl: `http://127.0.0.1:${port}` };
}

async function teardown(ctx: Ctx): Promise<void> {
  ctx.api.close();
  await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
  ctx.store.close();
}

interface ApiResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

async function call(
  ctx: Ctx,
  method: string,
  path: string,
  options: { token?: string | null; body?: unknown } = {},
): Promise<ApiResponse> {
  const token = options.token === undefined ? TOKEN : options.token;
  const headers: Record<string, string> = {};
  if (token !== null) {
    headers["authorization"] = `Bearer ${token}`;
  }
  let payload: string | undefined;
  if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = request(`${ctx.baseUrl}${path}`, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: unknown = undefined;
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

let ctx: Ctx;

before(async () => {
  ctx = await setup();
});

after(async () => {
  await teardown(ctx);
});

test("401 with no token, wrong token, right-length-wrong-content token; 200 with correct token", async () => {
  const noToken = await call(ctx, "GET", "/api/memories", { token: null });
  assert.equal(noToken.status, 401);

  const wrongToken = await call(ctx, "GET", "/api/memories", { token: "totally-different" });
  assert.equal(wrongToken.status, 401);

  const rightLengthWrongToken = await call(ctx, "GET", "/api/memories", {
    token: "x".repeat(TOKEN.length),
  });
  assert.equal(rightLengthWrongToken.status, 401);

  const ok = await call(ctx, "GET", "/api/memories");
  assert.equal(ok.status, 200);
});

test("handle returns false outside /api", async () => {
  const res = await call(ctx, "GET", "/health");
  // The wrapping test server answers plain 404 when handle() returns false.
  assert.equal(res.status, 404);
});

test("unknown /api path is 404; known path wrong method is 405", async () => {
  const unknown = await call(ctx, "GET", "/api/nope");
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { error: "not found" });

  const wrongMethod = await call(ctx, "POST", "/api/stats");
  assert.equal(wrongMethod.status, 405);
  assert.deepEqual(wrongMethod.body, { error: "method not allowed" });
});

test("memory round-trip: create, list, get, patch, delete, restore", async () => {
  const { memory } = ctx.store.remember({ content: "roundtrip memory", tags: ["a"] }, { sourceClient: "other" });

  const list = await call(ctx, "GET", "/api/memories");
  assert.equal(list.status, 200);
  const listBody = list.body as { mode: string; items: Array<{ id: string }> };
  assert.equal(listBody.mode, "list");
  assert.ok(listBody.items.some((item) => item.id === memory.id));

  const got = await call(ctx, "GET", `/api/memories/${memory.id}`);
  assert.equal(got.status, 200);
  assert.equal((got.body as { text: string }).text, "roundtrip memory");

  const patched = await call(ctx, "PATCH", `/api/memories/${memory.id}`, { body: { text: "updated" } });
  assert.equal(patched.status, 200);
  assert.equal((patched.body as { text: string }).text, "updated");

  const deleted = await call(ctx, "DELETE", `/api/memories/${memory.id}`);
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { deleted: true });

  const afterDelete = await call(ctx, "GET", "/api/memories");
  const afterDeleteBody = afterDelete.body as { items: Array<{ id: string }> };
  assert.ok(!afterDeleteBody.items.some((item) => item.id === memory.id));

  const restored = await call(ctx, "POST", `/api/memories/${memory.id}/restore`);
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body, { restored: true });

  const afterRestore = await call(ctx, "GET", "/api/memories");
  const afterRestoreBody = afterRestore.body as { items: Array<{ id: string }> };
  assert.ok(afterRestoreBody.items.some((item) => item.id === memory.id));
});

test("bulk forget then bulk restore; 201 ids is rejected", async () => {
  const ids = [
    ctx.store.remember({ content: "bulk one" }, { sourceClient: "other" }).memory.id,
    ctx.store.remember({ content: "bulk two" }, { sourceClient: "other" }).memory.id,
  ];

  const forgetRes = await call(ctx, "POST", "/api/memories/bulk", { body: { op: "forget", ids } });
  assert.equal(forgetRes.status, 200);
  const forgetBody = forgetRes.body as { op: string; count: number; results: Array<{ id: string; ok: boolean }> };
  assert.equal(forgetBody.op, "forget");
  assert.equal(forgetBody.count, 2);
  assert.ok(forgetBody.results.every((r) => r.ok));

  const restoreRes = await call(ctx, "POST", "/api/memories/bulk", { body: { op: "restore", ids } });
  assert.equal(restoreRes.status, 200);
  const restoreBody = restoreRes.body as { count: number };
  assert.equal(restoreBody.count, 2);

  const tooMany = Array.from({ length: 201 }, (_, i) => `id-${i}`);
  const rejected = await call(ctx, "POST", "/api/memories/bulk", { body: { op: "forget", ids: tooMany } });
  assert.equal(rejected.status, 400);
});

test("the dashboard cannot pause itself, but re-enabling it works", async () => {
  const disableAttempt = await call(ctx, "PATCH", `/api/clients/${DASHBOARD_CLIENT}`, {
    body: { enabled: false },
  });
  assert.equal(disableAttempt.status, 400);
  assert.deepEqual(disableAttempt.body, { error: "the dashboard cannot pause itself" });

  // Prove the dashboard was not locked out: an ordinary GET still works.
  const stillWorks = await call(ctx, "GET", "/api/memories");
  assert.equal(stillWorks.status, 200);

  const enableAttempt = await call(ctx, "PATCH", `/api/clients/${DASHBOARD_CLIENT}`, {
    body: { enabled: true },
  });
  assert.equal(enableAttempt.status, 200);
});

test("a percent-encoded spelling of the dashboard's own id is refused by the self-pause guard", async () => {
  // %63 is a lowercase "c" -- decodes to exactly DASHBOARD_CLIENT.
  const res = await call(ctx, "PATCH", "/api/clients/%63airn-dashboard", { body: { enabled: false } });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: "the dashboard cannot pause itself" });
});

test("PATCH /api/clients/:id round-trips a client id containing a space", async () => {
  ctx.store.remember({ content: "a memory from an IDE" }, { sourceClient: "Visual Studio Code" });

  const disable = await call(ctx, "PATCH", "/api/clients/Visual%20Studio%20Code", { body: { enabled: false } });
  assert.equal(disable.status, 200);
  assert.equal((disable.body as { enabled: boolean }).enabled, false);

  const list = await call(ctx, "GET", "/api/clients");
  const found = (list.body as { clients: Array<{ id: string; enabled: boolean }> }).clients.find(
    (c) => c.id === "Visual Studio Code",
  );
  assert.ok(found);
  assert.equal(found?.enabled, false);

  const enable = await call(ctx, "PATCH", "/api/clients/Visual%20Studio%20Code", { body: { enabled: true } });
  assert.equal(enable.status, 200);
});

test("GET /api/memories?q=...&tags=... narrows a search result by tag, same as list", async () => {
  ctx.store.remember({ content: "deploy the production server", tags: ["work"] }, { sourceClient: "other" });
  ctx.store.remember({ content: "deploy the personal blog", tags: ["personal"] }, { sourceClient: "other" });

  const res = await call(ctx, "GET", "/api/memories?q=deploy&tags=work");
  assert.equal(res.status, 200);
  const body = res.body as { mode: string; hits: Array<{ text: string }> };
  assert.equal(body.mode, "search");
  assert.ok(body.hits.some((h) => h.text.includes("production server")));
  assert.ok(!body.hits.some((h) => h.text.includes("personal blog")));
});

test("PATCH /api/memories/does-not-exist is 404, not 500", async () => {
  const res = await call(ctx, "PATCH", "/api/memories/does-not-exist", { body: { text: "x" } });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: "not found" });
});

test("POST /api/memories/nope/supersede is 404, not 500", async () => {
  const res = await call(ctx, "POST", "/api/memories/nope/supersede", { body: { text: "x" } });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: "not found" });
});

test("PATCH /api/clients/never-seen is 404, not 500", async () => {
  const res = await call(ctx, "PATCH", "/api/clients/never-seen", { body: { enabled: false } });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: "not found" });
});

test("PATCH with importance outside 0..1 is 400, not 500", async () => {
  const memory = ctx.store.remember({ content: "importance target" }, { sourceClient: "other" }).memory;
  const res = await call(ctx, "PATCH", `/api/memories/${memory.id}`, { body: { importance: 5 } });
  assert.equal(res.status, 400);
});

test("PATCH with a tags array over the cap is 400, not applied", async () => {
  const memory = ctx.store.remember({ content: "patch tags cap target" }, { sourceClient: "other" }).memory;
  const manyTags = Array.from({ length: 2000 }, (_, i) => `tag-${i}`);
  const res = await call(ctx, "PATCH", `/api/memories/${memory.id}`, { body: { tags: manyTags } });
  assert.equal(res.status, 400);
});

test("POST /api/memories/:id/supersede with a tags array over the cap is 400, not applied", async () => {
  const memory = ctx.store.remember({ content: "supersede tags cap target" }, { sourceClient: "other" }).memory;
  const manyTags = Array.from({ length: 2000 }, (_, i) => `tag-${i}`);
  const res = await call(ctx, "POST", `/api/memories/${memory.id}/supersede`, {
    body: { text: "replacement text", tags: manyTags },
  });
  assert.equal(res.status, 400);
});

test("PATCH on a superseded memory is a 409 conflict with no message leak", async () => {
  const memory = ctx.store.remember({ content: "will be superseded via api test" }, { sourceClient: "other" })
    .memory;
  ctx.store.supersede(memory.id, { text: "already superseded replacement" }, { sourceClient: "other" });
  const res = await call(ctx, "PATCH", `/api/memories/${memory.id}`, { body: { text: "edited" } });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: "conflict", reason: "superseded" });
});

// The concrete failure this guards: a PATCH that collides with a different
// LIVE memory's text (not a superseded one) must say "duplicate_text", never
// "superseded" -- the two reasons are otherwise indistinguishable at 409.
test("PATCH on a live memory whose new text collides is a 409 conflict with reason duplicate_text", async () => {
  ctx.store.remember({ content: "I use Postgres" }, { sourceClient: "other" });
  const b = ctx.store.remember({ content: "I use MySQL" }, { sourceClient: "other" }).memory;
  const res = await call(ctx, "PATCH", `/api/memories/${b.id}`, { body: { text: "I use Postgres" } });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: "conflict", reason: "duplicate_text" });

  const unchanged = ctx.store.get(b.id, {}, { sourceClient: "other" });
  assert.equal(unchanged?.text, "I use MySQL");
});

test("a supersede whose text collides with a live memory is a 409 conflict with reason duplicate_text", async () => {
  ctx.store.remember({ content: "alpha collision text" }, { sourceClient: "other" });
  const b = ctx.store.remember({ content: "bravo collision text" }, { sourceClient: "other" }).memory;
  const res = await call(ctx, "POST", `/api/memories/${b.id}/supersede`, { body: { text: "alpha collision text" } });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: "conflict", reason: "duplicate_text" });
});

test("PATCH whose text collides with a different live memory is a 409 conflict with reason duplicate_text", async () => {
  ctx.store.remember({ content: "alpha patch collision text" }, { sourceClient: "other" });
  const b = ctx.store.remember({ content: "bravo patch collision text" }, { sourceClient: "other" }).memory;
  const res = await call(ctx, "PATCH", `/api/memories/${b.id}`, { body: { text: "alpha patch collision text" } });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: "conflict", reason: "duplicate_text" });

  const unchanged = ctx.store.get(b.id, {}, { sourceClient: "other" });
  assert.equal(unchanged?.text, "bravo patch collision text");
});

test("restoring a memory whose text was re-remembered while deleted is a 409 conflict with reason duplicate_text", async () => {
  const original = ctx.store.remember({ content: "restore collision text" }, { sourceClient: "other" }).memory;
  ctx.store.forget(original.id, { sourceClient: "other" });
  ctx.store.remember({ content: "restore collision text" }, { sourceClient: "other" });

  const res = await call(ctx, "POST", `/api/memories/${original.id}/restore`);
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: "conflict", reason: "duplicate_text" });
});

test("bulk restore where the middle id collides reports that id ok:false and actually restores the others", async () => {
  const a = ctx.store.remember({ content: "bulk-restore alpha" }, { sourceClient: "other" }).memory;
  const collidingText = ctx.store.remember({ content: "bulk-restore collides" }, { sourceClient: "other" }).memory;
  const c = ctx.store.remember({ content: "bulk-restore charlie" }, { sourceClient: "other" }).memory;
  ctx.store.forget(a.id, { sourceClient: "other" });
  ctx.store.forget(collidingText.id, { sourceClient: "other" });
  ctx.store.forget(c.id, { sourceClient: "other" });
  // Re-remember the middle one's text as a new live row, so restoring the
  // original (deleted) row collides.
  ctx.store.remember({ content: "bulk-restore collides" }, { sourceClient: "other" });

  const res = await call(ctx, "POST", "/api/memories/bulk", {
    body: { op: "restore", ids: [a.id, collidingText.id, c.id] },
  });
  assert.equal(res.status, 200);
  const body = res.body as { results: Array<{ id: string; ok: boolean; reason?: string }> };
  const byId = new Map(body.results.map((r) => [r.id, r]));
  assert.equal(byId.get(a.id)?.ok, true);
  assert.equal(byId.get(collidingText.id)?.ok, false);
  assert.equal(byId.get(c.id)?.ok, true);

  // Assert the store state directly, not just the response body: a
  // response that claims success over an unapplied write is the failure
  // mode this test exists to catch.
  const storeA = ctx.store.get(a.id, { includeDeleted: true }, { sourceClient: "other" });
  const storeCollide = ctx.store.get(collidingText.id, { includeDeleted: true }, { sourceClient: "other" });
  const storeC = ctx.store.get(c.id, { includeDeleted: true }, { sourceClient: "other" });
  assert.equal(storeA?.deletedAt, null);
  assert.notEqual(storeCollide?.deletedAt, null);
  assert.equal(storeC?.deletedAt, null);
});

test("no CORS headers, and OPTIONS is not answered as a preflight", async () => {
  const res = await call(ctx, "GET", "/api/memories");
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  assert.deepEqual(
    Object.keys(res.headers).filter((h) => h.startsWith("access-control-")),
    [],
  );

  const options = await call(ctx, "OPTIONS", "/api/memories");
  // No preflight handler exists for this route/method combination, so it
  // falls through to the ordinary method-not-allowed handling -- a real
  // preflight handler would answer 204, so anything but exactly 405 here
  // means OPTIONS was accidentally treated as one.
  assert.equal(options.status, 405);
  assert.deepEqual(
    Object.keys(options.headers).filter((h) => h.startsWith("access-control-")),
    [],
  );
});

test("PUT /api/privacy then GET reflects it; invalid mode is rejected and unchanged", async () => {
  const put = await call(ctx, "PUT", "/api/privacy", { body: { mode: "strict" } });
  assert.equal(put.status, 200);

  const got = await call(ctx, "GET", "/api/privacy");
  assert.equal((got.body as { mode: string }).mode, "strict");

  const invalid = await call(ctx, "PUT", "/api/privacy", { body: { mode: "nonsense" } });
  assert.equal(invalid.status, 400);

  const stillGot = await call(ctx, "GET", "/api/privacy");
  assert.equal((stillGot.body as { mode: string }).mode, "strict");

  // Reset to "off" so later tests in this file that write memories are not
  // subject to strict-mode refusal.
  const reset = await call(ctx, "PUT", "/api/privacy", { body: { mode: "off" } });
  assert.equal(reset.status, 200);
});

test("delete-everything without confirm is a no-op; with confirm:true it deletes", async () => {
  ctx.store.remember({ content: "will be purged" }, { sourceClient: "other" });
  const before = ctx.store.stats({});

  const noConfirm = await call(ctx, "POST", "/api/privacy/delete-everything", { body: {} });
  assert.equal(noConfirm.status, 400);
  const afterNoConfirm = ctx.store.stats({});
  assert.equal(afterNoConfirm.liveMemories, before.liveMemories);

  const confirmed = await call(ctx, "POST", "/api/privacy/delete-everything", { body: { confirm: true } });
  assert.equal(confirmed.status, 200);
  const afterConfirmed = ctx.store.stats({});
  assert.equal(afterConfirmed.liveMemories, 0);
});

test("malformed cursor is a 400, not a 500", async () => {
  const res = await call(ctx, "GET", "/api/memories?cursor=not-a-real-cursor");
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: "malformed cursor" });
});

test("/api/stats reflects a known fixture", async () => {
  ctx.store.remember({ content: "stats fixture one", tags: ["fixture-tag"] }, { sourceClient: "other" });
  ctx.store.remember({ content: "stats fixture two", tags: ["fixture-tag"] }, { sourceClient: "other" });

  const res = await call(ctx, "GET", "/api/stats");
  assert.equal(res.status, 200);
  const body = res.body as {
    liveMemories: number;
    topTags: Array<{ tag: string; count: number }>;
    vectors: boolean;
    journalMode: string;
  };
  assert.equal(body.liveMemories, 2);
  const fixtureTag = body.topTags.find((t) => t.tag === "fixture-tag");
  assert.ok(fixtureTag);
  assert.equal(fixtureTag?.count, 2);
  assert.equal(body.vectors, ctx.store.capabilities.vectors);
  assert.equal(body.journalMode, ctx.store.capabilities.journalMode);
});

test("GET /api/memories?sourceClient=...&since=...&until=... filters as expected", async () => {
  const now = Date.now();
  const { memory: inRange } = ctx.store.remember({ content: "since/until fixture in range" }, { sourceClient: "filter-app" });
  const outOfRange = await call(ctx, "GET", `/api/memories?sourceClient=filter-app&since=${now + 1_000_000}`);
  assert.equal(outOfRange.status, 200);
  assert.ok(!(outOfRange.body as { items: Array<{ id: string }> }).items.some((i) => i.id === inRange.id));

  const bySourceClient = await call(ctx, "GET", "/api/memories?sourceClient=filter-app");
  assert.equal(bySourceClient.status, 200);
  const bySourceClientBody = bySourceClient.body as { items: Array<{ id: string; sourceClient: string | null }> };
  assert.ok(bySourceClientBody.items.some((i) => i.id === inRange.id));
  assert.ok(bySourceClientBody.items.every((i) => i.sourceClient === "filter-app"));

  const inWindow = await call(ctx, "GET", `/api/memories?sourceClient=filter-app&since=${inRange.createdAt}&until=${inRange.createdAt + 1}`);
  assert.equal(inWindow.status, 200);
  assert.ok((inWindow.body as { items: Array<{ id: string }> }).items.some((i) => i.id === inRange.id));

  ctx.store.forget(inRange.id);
});

test("a non-numeric since/until on GET /api/memories is 400", async () => {
  const badSince = await call(ctx, "GET", "/api/memories?since=not-a-number");
  assert.equal(badSince.status, 400);

  const badUntil = await call(ctx, "GET", "/api/memories?until=not-a-number");
  assert.equal(badUntil.status, 400);
});

test("SSE: connects, receives a published event, and close() leaves no open handle", async () => {
  await new Promise<void>((resolve, reject) => {
    let timeout: NodeJS.Timeout;
    const finish = (fn: () => void) => {
      clearTimeout(timeout);
      fn();
    };
    const req = request(
      `${ctx.baseUrl}/api/events`,
      { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } },
      (res) => {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
        let buffer = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          if (buffer.includes("event: updated")) {
            assert.ok(buffer.includes(`"uri"`));
            req.destroy();
            finish(resolve);
          }
        });
        res.on("error", () => {
          // req.destroy() above ends the response with an error on some
          // Node versions -- that is the expected way this stream ends.
        });
        // By the time the response headers have arrived, handleEvents has
        // already subscribed synchronously on the server -- safe to publish.
        ctx.bus.publish({ type: "updated", uri: "cairn://memory/test", sourceSessionId: "s1" });
      },
    );
    req.on("error", () => {
      // Same as above: destroying the request can surface as a client-side
      // socket error once the server has already sent what we needed.
    });
    req.end();
    timeout = setTimeout(() => finish(() => reject(new Error("timed out waiting for SSE event"))), 5000);
  });
  // The bus must have no lingering listener from the stream above once the
  // request has been destroyed and the server has noticed the close.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ctx.bus.listenerCount, 0);
});

test("401 on /api/events specifically, not just /api/memories", async () => {
  const res = await call(ctx, "GET", "/api/events", { token: null });
  assert.equal(res.status, 401);
});

test("a request body over the 4 MB cap is rejected with 413", async () => {
  const oversized = "x".repeat(5 * 1024 * 1024);
  const res = await call(ctx, "PATCH", "/api/memories/does-not-exist", { body: { text: oversized } });
  assert.equal(res.status, 413);
});

test("401 on /api/context specifically, not just /api/memories", async () => {
  const res = await call(ctx, "GET", "/api/context", { token: null });
  assert.equal(res.status, 401);
});

test("GET /api/context with no q falls back to a non-empty recency/importance block", async () => {
  ctx.store.remember({ content: "context fallback fixture one", scope: "context-fixture" }, { sourceClient: "other" });
  ctx.store.remember({ content: "context fallback fixture two", scope: "context-fixture" }, { sourceClient: "other" });

  const res = await call(ctx, "GET", "/api/context?scope=context-fixture");
  assert.equal(res.status, 200);
  const body = res.body as {
    text: string;
    memories: Array<{ id: string; text: string }>;
    tokensEstimated: number;
    truncated: boolean;
    degraded: boolean;
    degradedReason: string | null;
  };
  assert.ok(body.text.length > 0);
  assert.ok(body.memories.some((m) => m.text === "context fallback fixture one"));
  assert.ok(body.memories.some((m) => m.text === "context fallback fixture two"));
});

test("GET /api/context?q=... ranks the matching memory in and the unrelated one out", async () => {
  ctx.store.remember({ content: "kubernetes deployment rollback procedure", scope: "context-q-fixture" }, { sourceClient: "other" });
  ctx.store.remember({ content: "a completely unrelated pet grooming note", scope: "context-q-fixture" }, { sourceClient: "other" });

  const res = await call(ctx, "GET", "/api/context?scope=context-q-fixture&q=kubernetes+deployment+rollback");
  assert.equal(res.status, 200);
  const body = res.body as { memories: Array<{ text: string }> };
  assert.ok(body.memories.some((m) => m.text.includes("kubernetes deployment rollback")));
  assert.ok(!body.memories.some((m) => m.text.includes("pet grooming")));
});

test("GET /api/context?scope=... narrows the result to that scope", async () => {
  ctx.store.remember({ content: "scope narrow fixture in scope", scope: "context-scope-a" }, { sourceClient: "other" });
  ctx.store.remember({ content: "scope narrow fixture out of scope", scope: "context-scope-b" }, { sourceClient: "other" });

  const res = await call(ctx, "GET", "/api/context?scope=context-scope-a");
  assert.equal(res.status, 200);
  const body = res.body as { memories: Array<{ text: string }> };
  assert.ok(body.memories.some((m) => m.text === "scope narrow fixture in scope"));
  assert.ok(!body.memories.some((m) => m.text === "scope narrow fixture out of scope"));
});

test("GET /api/context?budget=... is honoured: tokensEstimated never exceeds it, and truncated is set", async () => {
  for (let i = 0; i < 20; i++) {
    ctx.store.remember(
      { content: `budget fixture memory number ${i} with enough padding text to cost real tokens`, scope: "context-budget-fixture" },
      { sourceClient: "other" },
    );
  }

  const unbudgeted = await call(ctx, "GET", "/api/context?scope=context-budget-fixture");
  assert.equal(unbudgeted.status, 200);
  const unbudgetedBody = unbudgeted.body as { tokensEstimated: number; memories: unknown[] };
  // Sanity check the fixture itself: an unbudgeted response must already
  // exceed the tiny budget below, or a broken budget could not be caught.
  assert.ok(unbudgetedBody.tokensEstimated > 50);

  const tiny = await call(ctx, "GET", "/api/context?scope=context-budget-fixture&budget=50");
  assert.equal(tiny.status, 200);
  const tinyBody = tiny.body as { tokensEstimated: number; memories: unknown[]; truncated: boolean };
  assert.ok(tinyBody.tokensEstimated <= 50);
  assert.ok(tinyBody.memories.length < unbudgetedBody.memories.length);
  assert.equal(tinyBody.truncated, true);
});

test("a non-numeric budget on GET /api/context is 400", async () => {
  const res = await call(ctx, "GET", "/api/context?budget=not-a-number");
  assert.equal(res.status, 400);
});

test("the 51st concurrent SSE stream is refused with 503", async () => {
  const openReqs: ReturnType<typeof request>[] = [];
  try {
    for (let i = 0; i < 50; i++) {
      await new Promise<void>((resolve, reject) => {
        const req = request(
          `${ctx.baseUrl}/api/events`,
          { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } },
          (res) => {
            assert.equal(res.statusCode, 200);
            resolve();
          },
        );
        req.on("error", reject);
        req.end();
        openReqs.push(req);
      });
    }
    const overflow = await call(ctx, "GET", "/api/events");
    assert.equal(overflow.status, 503);
  } finally {
    for (const req of openReqs) req.destroy();
    // Give the server a moment to notice each destroyed socket and clean
    // up its SSE stream before any later test relies on the stream count.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

// A sentinel embedding provider failure message, chosen to look exactly
// like what an HTTP-backed provider (Ollama/OpenAI/Voyage, BUILD_BRIEF §3)
// would actually throw -- a URL naming its own upstream host.
const LEAKY_SENTINEL = "https://secret.internal/v1/embeddings";

async function setupWithFailingProvider(): Promise<Ctx> {
  const dir = makeTempDir();
  const modelId = "leaky-provider-model";
  const dim = 8;
  // Build the vector space against the same db/model/dim the store below is
  // opened with -- ensureVectorSpace needs the db to already exist, so a
  // throwaway store is opened first just to create it, then closed.
  const bootstrap = openStore({ path: tempDbPath(dir) });
  const space = ensureVectorSpace(bootstrap.db, modelId, dim);
  assert.equal(bootstrap.capabilities.vectors, true, "sqlite-vec must load for this test to be meaningful");
  bootstrap.close();
  // The fake provider always throws with a message carrying the sentinel --
  // same shape as a real HTTP provider's error (a URL naming its own
  // upstream host), per src/retrieval/search.test.ts's "rejecting provider"
  // pattern.
  const provider = createFakeProvider({ modelId, dim, failOn: () => true });
  provider.embed = async () => {
    throw new Error(`request to ${LEAKY_SENTINEL} failed`);
  };
  const store = openStore({ path: tempDbPath(dir), provider, space });
  const bus = new MemoryEventBus();
  const api = createDashboardApi({ store, token: TOKEN, bus });
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const handled = await api.handle(req, res, url);
      if (!handled) {
        res.writeHead(404).end();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { dir, store, bus, api, server, baseUrl: `http://127.0.0.1:${port}` };
}

test("GET /api/context never echoes a failing embedding provider's raw message", async () => {
  const failCtx = await setupWithFailingProvider();
  try {
    failCtx.store.remember({ content: "context leak-check fixture", scope: "leak-check" }, { sourceClient: "other" });
    const res = await call(failCtx, "GET", "/api/context?scope=leak-check&q=leak-check");
    assert.equal(res.status, 200);
    const raw = JSON.stringify(res.body);
    assert.ok(!raw.includes(LEAKY_SENTINEL), "response must not contain the provider's raw message");
    const body = res.body as { degraded: boolean; degradedReason: string | null };
    assert.equal(body.degraded, true);
    assert.equal(body.degradedReason, "embedding_failed");
  } finally {
    await teardown(failCtx);
  }
});

test("GET /api/memories?q=... (search mode) never echoes a failing embedding provider's raw message", async () => {
  const failCtx = await setupWithFailingProvider();
  try {
    failCtx.store.remember({ content: "search leak-check fixture" }, { sourceClient: "other" });
    const res = await call(failCtx, "GET", "/api/memories?q=leak-check");
    assert.equal(res.status, 200);
    const raw = JSON.stringify(res.body);
    assert.ok(!raw.includes(LEAKY_SENTINEL), "response must not contain the provider's raw message");
    const body = res.body as { mode: string; degraded: boolean; degradedReason: string | null };
    assert.equal(body.mode, "search");
    assert.equal(body.degraded, true);
    assert.equal(body.degradedReason, "embedding_failed");
  } finally {
    await teardown(failCtx);
  }
});

function chatGptConversationWithCustomInstructions(contextData: Record<string, unknown>): unknown {
  return {
    title: "Some chat",
    mapping: {
      "root-node-id": { message: null },
      "system-node-id": {
        message: {
          author: { role: "system" },
          metadata: {
            is_user_system_message: true,
            user_context_message_data: contextData,
          },
        },
      },
    },
  };
}

test("POST /api/import/pasted imports a realistic pasted blob, findable via store.list", async () => {
  const blob = [
    "- Works as a backend engineer",
    "1. Lives in Berlin",
    "",
    "2) Prefers Vim",
    "   ",
    "Plain line memory",
  ].join("\n");

  const res = await call(ctx, "POST", "/api/import/pasted", { body: { text: blob } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { imported: 4, skipped: 0, refused: 0 });

  const list = ctx.store.list({});
  const texts = list.items.map((m) => m.text);
  assert.ok(texts.includes("Works as a backend engineer"));
  assert.ok(texts.includes("Lives in Berlin"));
  assert.ok(texts.includes("Prefers Vim"));
  assert.ok(texts.includes("Plain line memory"));
});

test("re-posting the same pasted text imports nothing the second time (content-hash dedupe)", async () => {
  const blob = "- A distinct dedupe-check memory\n- Another distinct dedupe-check memory";

  const first = await call(ctx, "POST", "/api/import/pasted", { body: { text: blob } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { imported: 2, skipped: 0, refused: 0 });

  const second = await call(ctx, "POST", "/api/import/pasted", { body: { text: blob } });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { imported: 0, skipped: 2, refused: 0 });
});

test("POST /api/import/pasted applies scope and tags", async () => {
  const res = await call(ctx, "POST", "/api/import/pasted", {
    body: { text: "A scoped-and-tagged import fixture", scope: "import-scope", tags: ["from-paste"] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { imported: 1, skipped: 0, refused: 0 });

  const list = ctx.store.list({ scope: "import-scope" });
  const item = list.items.find((m) => m.text === "A scoped-and-tagged import fixture");
  assert.ok(item);
  assert.equal(item?.scope, "import-scope");
  assert.ok(item?.tags.includes("from-paste"));
});

test("POST /api/import/pasted refuses a tags array over the cap with 400 rather than amplifying it across every entry", async () => {
  const manyTags = Array.from({ length: 2000 }, (_, i) => `tag-${i}`);
  const res = await call(ctx, "POST", "/api/import/pasted", {
    body: { text: "A line one\nA line two\nA line three", tags: manyTags },
  });
  assert.equal(res.status, 400);
  const list = ctx.store.list({});
  assert.ok(!list.items.some((m) => m.text === "A line one"), "nothing should have been written on refusal");
});

test("POST /api/import/pasted refuses a single over-long tag", async () => {
  const res = await call(ctx, "POST", "/api/import/pasted", {
    body: { text: "An over-long-tag fixture", tags: ["x".repeat(65)] },
  });
  assert.equal(res.status, 400);
});

test("POST /api/import/pasted with a handful of short tags still succeeds", async () => {
  const res = await call(ctx, "POST", "/api/import/pasted", {
    body: { text: "A normal-tags fixture", tags: ["work", "berlin", "vim"] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { imported: 1, skipped: 0, refused: 0 });
});

test("POST /api/import/pasted publishes a list_changed event on the bus", async () => {
  const events: Array<{ type: string }> = [];
  const unsubscribe = ctx.bus.subscribe((event) => events.push(event));
  try {
    const res = await call(ctx, "POST", "/api/import/pasted", { body: { text: "An event-publishing fixture" } });
    assert.equal(res.status, 200);
    assert.ok(events.some((e) => e.type === "list_changed"));
  } finally {
    unsubscribe();
  }
});

test("POST /api/import/pasted in strict privacy mode refuses only the offending lines, not a 500", async () => {
  const put = await call(ctx, "PUT", "/api/privacy", { body: { mode: "strict" } });
  assert.equal(put.status, 200);
  try {
    const blob = [
      "A perfectly ordinary first memory",
      "Another ordinary memory",
      "My AWS key is AKIAABCDEFGHIJKLMNOP",
      "A perfectly ordinary last memory",
    ].join("\n");

    const res = await call(ctx, "POST", "/api/import/pasted", { body: { text: blob } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { imported: 3, skipped: 0, refused: 1 });

    const list = ctx.store.list({});
    const texts = list.items.map((m) => m.text);
    assert.ok(texts.includes("A perfectly ordinary first memory"));
    assert.ok(texts.includes("Another ordinary memory"));
    assert.ok(texts.includes("A perfectly ordinary last memory"));
    assert.ok(!texts.some((t) => t.includes("AKIA")));
  } finally {
    // Reset to "off" so later tests in this file that write memories are not
    // subject to strict-mode refusal.
    const reset = await call(ctx, "PUT", "/api/privacy", { body: { mode: "off" } });
    assert.equal(reset.status, 200);
  }
});

test("POST /api/import/chatgpt imports found custom instructions", async () => {
  const conversations = [
    chatGptConversationWithCustomInstructions({
      about_user_message: "Works as a backend engineer.",
      about_model_message: "Be concise.",
    }),
  ];

  const res = await call(ctx, "POST", "/api/import/chatgpt", { body: { conversations } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { imported: 2, skipped: 0, refused: 0, found: 2 });

  const list = ctx.store.list({});
  const texts = list.items.map((m) => m.text);
  assert.ok(texts.includes("Works as a backend engineer."));
  assert.ok(texts.includes("Be concise."));
});

test("POST /api/import/chatgpt with no custom instructions returns found: 0, not an error", async () => {
  const conversations = [
    {
      title: "Ordinary chat",
      mapping: {
        "root-node-id": { message: null },
      },
    },
  ];

  const res = await call(ctx, "POST", "/api/import/chatgpt", { body: { conversations } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { imported: 0, skipped: 0, refused: 0, found: 0 });
});

test("POST /api/import/chatgpt in strict privacy mode refuses only the offending field, not a 500", async () => {
  const put = await call(ctx, "PUT", "/api/privacy", { body: { mode: "strict" } });
  assert.equal(put.status, 200);
  try {
    const conversations = [
      chatGptConversationWithCustomInstructions({
        about_user_message: "My AWS key is AKIAABCDEFGHIJKLMNOP",
        about_model_message: "A distinct strict-mode-clean model instruction.",
      }),
    ];

    const res = await call(ctx, "POST", "/api/import/chatgpt", { body: { conversations } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { imported: 1, skipped: 0, refused: 1, found: 2 });

    const list = ctx.store.list({});
    const texts = list.items.map((m) => m.text);
    assert.ok(texts.includes("A distinct strict-mode-clean model instruction."));
    assert.ok(!texts.some((t) => t.includes("AKIA")));
  } finally {
    // Reset to "off" so later tests in this file that write memories are not
    // subject to strict-mode refusal.
    const reset = await call(ctx, "PUT", "/api/privacy", { body: { mode: "off" } });
    assert.equal(reset.status, 200);
  }
});

test("POST /api/import/chatgpt with a non-export body returns 400 and echoes none of the input", async () => {
  const secret = "sk-super-secret-user-conversation-content-do-not-leak";
  const res = await call(ctx, "POST", "/api/import/chatgpt", { body: { conversations: secret } });
  assert.equal(res.status, 400);
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes(secret));
});

test("401 without a bearer token on both import routes", async () => {
  const pasted = await call(ctx, "POST", "/api/import/pasted", { token: null, body: { text: "x" } });
  assert.equal(pasted.status, 401);

  const chatgpt = await call(ctx, "POST", "/api/import/chatgpt", { token: null, body: { conversations: [] } });
  assert.equal(chatgpt.status, 401);
});

test("an oversized body is refused on both import routes", async () => {
  const oversized = "x".repeat(5 * 1024 * 1024);

  const pasted = await call(ctx, "POST", "/api/import/pasted", { body: { text: oversized } });
  assert.equal(pasted.status, 413);

  const chatgpt = await call(ctx, "POST", "/api/import/chatgpt", { body: { conversations: oversized } });
  assert.equal(chatgpt.status, 413);
});
