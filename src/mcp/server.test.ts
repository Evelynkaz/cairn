// Exercises the MCP tool surface through a real client, over
// InMemoryTransport.createLinkedPair() -- calling handlers directly would
// skip schema validation, alias normalisation, and the SDK's own
// serialisation, which is exactly where this layer's bugs live. No test
// here configures an embedding provider, so every test also doubles as
// coverage of the §2 FTS-only default.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeTempDir, tempDbPath } from "../testing/tmp.js";
import { openStore } from "../storage/index.js";
import type { Store } from "../storage/index.js";
import { createMcpServer } from "./server.js";
import { MemoryEventBus } from "./events.js";
import { DASHBOARD_CLIENT } from "../dashboard/api.js";
import { dbPath } from "../config/paths.js";
import { runtimeFilePath, writeRuntimeFile } from "../daemon/runtime-file.js";
import { exportArchive } from "../portability/archive.js";

interface RememberResult {
  id: string;
  deduped: boolean;
  episodeId: string;
}

interface RecallHit {
  id: string;
  text: string;
  score: number;
  scope: string;
  tags: string[];
  importance: number;
  createdAt: number;
}

interface RecallResult {
  hits: RecallHit[];
  degraded: boolean;
  degradedReason: string | null;
}

interface ContextResult {
  text: string;
  memories: RecallHit[];
  tokensEstimated: number;
  truncated: boolean;
  degraded: boolean;
  degradedReason: string | null;
}

interface ListedMemory {
  id: string;
  text: string;
  scope: string;
  tags: string[];
  importance: number;
  createdAt: number;
}

interface ListResult {
  items: ListedMemory[];
  nextCursor: string | null;
}

interface UpdateResult {
  id: string;
  text: string;
  importance: number;
}

interface ForgetByIdResult {
  deleted: boolean;
  id: string;
}

interface ForgetPreviewResult {
  deleted: boolean;
  count: number;
  ids: string[];
  wouldDelete: Array<{ id: string; text: string; scope: string }>;
  message: string;
}

interface ForgetConfirmedResult {
  deleted: boolean;
  count: number;
  ids: string[];
}

interface ExportResult {
  path: string;
  bytes: number;
  memories: number;
  episodes: number;
}

interface ImportResult {
  imported: number;
  skipped: number;
}

interface TestEnv {
  client: Client;
  store: Store;
}

async function withServer<T>(fn: (env: TestEnv) => Promise<T>, clientName = "test-client"): Promise<T> {
  const dir = makeTempDir();
  const store = openStore({ path: tempDbPath(dir) });
  const server = createMcpServer({ store });
  const client = new Client({ name: clientName, version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await fn({ client, store });
  } finally {
    await client.close();
    await server.close();
    store.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Best-effort: never mask the real failure from fn() with a cleanup error.
    }
  }
}

interface SharedBusEnv {
  store: Store;
  bus: MemoryEventBus;
  makeClient(name: string): Promise<{ client: Client; server: McpServer }>;
}

// The cross-session counterpart to withServer: several createMcpServer
// instances sharing one store and one MemoryEventBus, the way daemon/
// server.ts wires up several sessions off of one daemon. Each test closes
// its own clients/servers (order and timing of that close is itself part
// of what some of these tests assert), so this helper only owns the store.
async function withSharedBus<T>(fn: (env: SharedBusEnv) => Promise<T>): Promise<T> {
  const dir = makeTempDir();
  const store = openStore({ path: tempDbPath(dir) });
  const bus = new MemoryEventBus();
  async function makeClient(name: string): Promise<{ client: Client; server: McpServer }> {
    const server = createMcpServer({ store, bus });
    const client = new Client({ name, version: "1.0.0" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, server };
  }
  try {
    return await fn({ store, bus, makeClient });
  } finally {
    store.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Best-effort: never mask the real failure from fn() with a cleanup error.
    }
  }
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  if (!("content" in result) || !Array.isArray(result.content)) {
    throw new Error(`tool ${name} returned no content array`);
  }
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error(`tool ${name} returned no text content`);
  }
  return { text: first.text, isError: result.isError === true };
}

async function callJson<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { text, isError } = await callTool(client, name, args);
  if (isError) {
    throw new Error(`tool ${name} returned an error: ${text}`);
  }
  return JSON.parse(text) as T;
}

function firstResourceText(contents: Array<{ uri: string; text: string } | { uri: string; blob: string }>): string {
  const first = contents[0];
  if (!first || !("text" in first)) {
    throw new Error("resource returned no text content");
  }
  return first.text;
}

test("tools/list returns exactly the eight §6 tools, by exact name", async () => {
  await withServer(async ({ client }) => {
    const { tools } = await client.listTools();
    // 8 is a deliberate ceiling (§6/§2: export_memories/import_memories are
    // one conceptual slot), not an incidental number -- read tools.ts's
    // opening comment before changing this.
    assert.equal(tools.length, 8);
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "export_memories",
      "forget",
      "get_context",
      "import_memories",
      "list_memories",
      "recall",
      "remember",
      "update_memory",
    ]);
  });
});

const DESCRIPTION_KEYWORDS = ["call", "example"];

// The tool's own primary parameter, as it must literally appear in an
// example invocation in the description (e.g. `recall(query:`) -- a
// placeholder description satisfying only length + "call"/"example" would
// pass the old, weaker version of this test.
const TOOL_PRIMARY_PARAM: Record<string, string> = {
  remember: "content",
  recall: "query",
  get_context: "query",
  list_memories: "scope",
  update_memory: "id",
  forget: "query",
  export_memories: "path",
  import_memories: "path",
};

test("every tool description says WHEN to call it and gives an example invocation of its own primary parameter", async () => {
  await withServer(async ({ client }) => {
    const { tools } = await client.listTools();
    // 8 is a deliberate ceiling (§6/§2), not an incidental number -- read
    // tools.ts's opening comment before changing this.
    assert.equal(tools.length, 8);
    for (const tool of tools) {
      const description = tool.description ?? "";
      assert.ok(description.trim().length > 40, `${tool.name} has a real description`);
      const lower = description.toLowerCase();
      for (const keyword of DESCRIPTION_KEYWORDS) {
        assert.ok(lower.includes(keyword), `${tool.name} description mentions "${keyword}"`);
      }
      const param = TOOL_PRIMARY_PARAM[tool.name];
      assert.ok(param, `${tool.name} has a primary-param expectation configured in this test`);
      const exampleCall = `${tool.name}(${param}:`;
      assert.ok(
        description.includes(exampleCall),
        `${tool.name} description must contain an example invocation like \`${exampleCall}\`, got: ${description}`,
      );
    }
  });
});

test("remember then recall round-trips; re-remembering the same text dedupes", async () => {
  await withServer(async ({ client, store }) => {
    const first = await callJson<RememberResult>(client, "remember", { content: "The user prefers dark mode." });
    assert.equal(first.deduped, false);
    assert.ok(first.id);
    assert.ok(first.episodeId);

    const again = await callJson<RememberResult>(client, "remember", { content: "The user prefers dark mode." });
    assert.equal(again.deduped, true);
    assert.equal(again.id, first.id);

    const stored = store.list().items.filter((m) => m.id === first.id);
    assert.equal(stored.length, 1);

    const recalled = await callJson<RecallResult>(client, "recall", { query: "dark mode" });
    assert.ok(recalled.hits.some((h) => h.id === first.id));
    assert.equal(recalled.degraded, false);
  });
});

test("recall accepts q/text as aliases for query; remember accepts text as an alias for content", async () => {
  await withServer(async ({ client }) => {
    const remembered = await callJson<RememberResult>(client, "remember", { text: "Favorite editor is Neovim." });
    assert.ok(remembered.id);

    const byQ = await callJson<RecallResult>(client, "recall", { q: "favorite editor" });
    assert.ok(byQ.hits.some((h) => h.id === remembered.id));

    const byText = await callJson<RecallResult>(client, "recall", { text: "Neovim" });
    assert.ok(byText.hits.some((h) => h.id === remembered.id));
  });
});

test("get_context respects token_budget", async () => {
  await withServer(async ({ client }) => {
    for (let i = 0; i < 5; i++) {
      await callJson(client, "remember", {
        content: `Fact number ${i} about the deployment pipeline and its configuration details.`,
        importance: 0.9,
      });
    }
    const block = await callJson<ContextResult>(client, "get_context", { query: "deployment pipeline", token_budget: 20 });
    assert.ok(block.tokensEstimated <= 20, `tokensEstimated (${block.tokensEstimated}) must stay within the 20-token budget`);
    assert.equal(block.truncated, true);
  });
});

test("list_memories paginates through a cursor", async () => {
  await withServer(async ({ client }) => {
    for (let i = 0; i < 5; i++) {
      await callJson(client, "remember", { content: `Paginated memory number ${i}` });
    }
    const page1 = await callJson<ListResult>(client, "list_memories", { limit: 2 });
    assert.equal(page1.items.length, 2);
    assert.ok(page1.nextCursor);

    const page2 = await callJson<ListResult>(client, "list_memories", { limit: 2, cursor: page1.nextCursor });
    assert.equal(page2.items.length, 2);

    const ids1 = new Set(page1.items.map((m) => m.id));
    for (const item of page2.items) {
      assert.ok(!ids1.has(item.id), "page 2 must not repeat a page 1 item");
    }
  });
});

// An out-of-range or wrong-typed number is an ordinary model mistake, not a
// malformed call -- BUILD_BRIEF §6's forgiving-parameter principle applies
// to a mis-VALUED param the same as a mis-NAMED one. None of these must
// return isError.
test("out-of-range or numeric-string limits are clamped, not rejected", async () => {
  await withServer(async ({ client }) => {
    for (let i = 0; i < 3; i++) {
      await callJson(client, "remember", { content: `Clamp probe memory number ${i} about oversized limits.` });
    }

    const recallOver = await callTool(client, "recall", { query: "oversized limits", limit: 100 });
    assert.equal(recallOver.isError, false, "recall(limit: 100) must not be rejected");
    assert.ok((JSON.parse(recallOver.text) as RecallResult).hits.length <= 50, "recall(limit: 100) must clamp to the documented cap of 50");

    const listOver = await callTool(client, "list_memories", { limit: 1000 });
    assert.equal(listOver.isError, false, "list_memories(limit: 1000) must not be rejected");
    assert.ok(
      (JSON.parse(listOver.text) as ListResult).items.length <= 200,
      "list_memories(limit: 1000) must clamp to the documented cap of 200",
    );

    const stringLimit = await callJson<RecallResult>(client, "recall", { query: "oversized limits", limit: "10" });
    assert.ok(stringLimit.hits.length <= 10, 'recall(limit: "10") must be coerced from a numeric string, not rejected');

    const nonsenseLimit = await callTool(client, "recall", { query: "oversized limits", limit: "not-a-number" });
    assert.equal(nonsenseLimit.isError, false, "a non-numeric limit string must fall back to the default, not error");
  });
});

test("out-of-range importance is clamped, not rejected", async () => {
  await withServer(async ({ client, store }) => {
    const { isError, text } = await callTool(client, "remember", { content: "Importance clamp probe.", importance: 5 });
    assert.equal(isError, false, "remember(importance: 5) must not be rejected");
    const remembered = JSON.parse(text) as RememberResult;
    const stored = store.list({ limit: 200 }).items.find((m) => m.id === remembered.id);
    assert.ok(stored, "remembered memory must exist");
    assert.ok(stored.importance <= 1, `remember(importance: 5) must clamp to 1, got ${stored.importance}`);

    const updated = await callJson<UpdateResult>(client, "update_memory", { id: remembered.id, importance: -3 });
    assert.ok(updated.importance >= 0, `update_memory(importance: -3) must clamp to 0, got ${updated.importance}`);
  });
});

test("get_context token_budget rejects nothing: 0, negative, and numeric strings are all clamped", async () => {
  await withServer(async ({ client }) => {
    await callJson(client, "remember", { content: "Fact for the token_budget clamp probe.", importance: 0.9 });

    for (const tokenBudget of [0, -5, "200"]) {
      const { isError } = await callTool(client, "get_context", { query: "token_budget clamp probe", token_budget: tokenBudget });
      assert.equal(isError, false, `get_context(token_budget: ${JSON.stringify(tokenBudget)}) must not be rejected`);
    }
  });
});

test("update_memory edits a memory; forget by id removes it from recall", async () => {
  await withServer(async ({ client }) => {
    const remembered = await callJson<RememberResult>(client, "remember", { content: "Old fact about the roadmap." });

    const updated = await callJson<UpdateResult>(client, "update_memory", {
      id: remembered.id,
      content: "Updated fact about the roadmap.",
      importance: 0.9,
    });
    assert.equal(updated.text, "Updated fact about the roadmap.");
    assert.equal(updated.importance, 0.9);

    const before = await callJson<RecallResult>(client, "recall", { query: "roadmap" });
    assert.ok(before.hits.some((h) => h.id === remembered.id));

    const forgotten = await callJson<ForgetByIdResult>(client, "forget", { id: remembered.id });
    assert.equal(forgotten.deleted, true);

    const after = await callJson<RecallResult>(client, "recall", { query: "roadmap" });
    assert.ok(!after.hits.some((h) => h.id === remembered.id));
  });
});

test("forget by query without confirm deletes nothing; with confirm: true it deletes", async () => {
  await withServer(async ({ client, store }) => {
    await callJson(client, "remember", { content: "Sensitive detail about the old job at Acme." });
    await callJson(client, "remember", { content: "Another note about the old job at Acme." });

    const beforeCount = store.list({ limit: 200 }).items.length;

    const preview = await callJson<ForgetPreviewResult>(client, "forget", { query: "old job at Acme" });
    assert.equal(preview.deleted, false);
    assert.ok(preview.wouldDelete.length >= 2);

    const afterPreviewCount = store.list({ limit: 200 }).items.length;
    assert.equal(afterPreviewCount, beforeCount, "a preview (no confirm) must delete nothing");

    const confirmed = await callJson<ForgetConfirmedResult>(client, "forget", { query: "old job at Acme", confirm: true });
    assert.equal(confirmed.deleted, true);
    assert.ok(confirmed.count >= 2);

    const afterConfirmCount = store.list({ limit: 200 }).items.length;
    assert.equal(afterConfirmCount, beforeCount - confirmed.count, "confirm: true must actually delete the matches");
  });
});

// The safe form of confirm: pass back exactly the ids a preview returned,
// so the delete cannot pick up a memory another client wrote (or that
// re-ranking shifted in) between the preview and the confirm.
test("forget preview returns bounded ids; confirm with those ids deletes exactly them, not a re-run search", async () => {
  await withServer(async ({ client, store }) => {
    await callJson(client, "remember", { content: "Old note about the Contoso contract." });
    await callJson(client, "remember", { content: "Another old note about the Contoso contract." });

    const preview = await callJson<ForgetPreviewResult>(client, "forget", { query: "Contoso contract" });
    assert.equal(preview.deleted, false);
    assert.ok(preview.ids.length >= 2);
    assert.deepEqual(
      preview.ids,
      preview.wouldDelete.map((m) => m.id),
      "preview `ids` must name exactly the memories listed in `wouldDelete`",
    );
    assert.ok(preview.ids.length <= 50, "an unbounded forget preview would defeat §13's bounded-output rule");

    // A memory written after the preview but matching the same query must
    // NOT be swept in by an ids-based confirm.
    const late = await callJson<RememberResult>(client, "remember", { content: "Late note about the Contoso contract." });

    const beforeCount = store.list({ limit: 200 }).items.length;
    const confirmed = await callJson<ForgetConfirmedResult>(client, "forget", { ids: preview.ids, confirm: true });
    assert.equal(confirmed.deleted, true);
    assert.deepEqual([...confirmed.ids].sort(), [...preview.ids].sort());

    const afterCount = store.list({ limit: 200 }).items.length;
    assert.equal(afterCount, beforeCount - preview.ids.length, "must delete exactly the previewed ids, no more, no fewer");

    const stillThere = store.list({ limit: 200 }).items.find((m) => m.id === late.id);
    assert.ok(stillThere, "the late-written memory matching the same query must survive an ids-scoped confirm");
  });
});

// Table-driven over the actual registered tool set (not a hardcoded list of
// six names) so a newly added tool that forgets to route through a gated
// Store method fails BOTH tests below: the coverage test if it is missing
// from this table, and the pause test if it is present but ungated. This is
// the regression test for the bug where forget()'s query-preview form
// called the retrieval layer directly and so never reached the per-client
// pause gate (BUILD_BRIEF §9/§10): with a client paused, every other tool
// already refused, but forget(query) happily returned memory content.
const LEAK_MARKER = "must-not-leak-while-paused";

const TOOL_PROBE_ARGS: Record<string, Record<string, unknown>> = {
  remember: { content: `remember attempted while paused ${LEAK_MARKER}` },
  recall: { query: LEAK_MARKER },
  get_context: { query: LEAK_MARKER },
  list_memories: {},
  update_memory: { id: "does-not-exist", content: `update attempted while paused ${LEAK_MARKER}` },
  forget: { query: LEAK_MARKER },
  export_memories: {},
  import_memories: { path: "/does-not-exist-pause-probe.zip" },
};

test("the tool probe table covers exactly the registered tool set", async () => {
  await withServer(async ({ client }) => {
    const { tools } = await client.listTools();
    assert.deepEqual([...tools.map((t) => t.name)].sort(), Object.keys(TOOL_PROBE_ARGS).sort());
  });
});

// A rejection thrown by a resource read handler surfaces to the client as a
// rejected request (unlike a tool call, which returns isError: true), so
// this asserts on the rejection and, defensively, that neither the thrown
// error's message leaks the marker.
async function assertResourceReadRefused(client: Client, uri: string): Promise<void> {
  await assert.rejects(
    () => client.readResource({ uri }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(!message.includes(LEAK_MARKER), `readResource(${uri}) leaked memory content while paused: ${message}`);
      return true;
    },
    `readResource(${uri}) did not refuse a paused client`,
  );
}

test("a paused client is refused on every one of the eight tools, and none returns memory content", async () => {
  const clientName = "paused-mcp-client";
  const archiveDir = makeTempDir();
  try {
    await withServer(async ({ client, store }) => {
      const seeded = await callJson<RememberResult>(client, "remember", { content: `seed memory containing ${LEAK_MARKER}` });

      // import_memories' probe must point at a REAL, readable archive.
      // Pointing it at a nonexistent path (as before) makes the tool refuse
      // for a filesystem reason before the pause gate is ever consulted, so
      // deleting the gate would leave this test green for the wrong reason.
      // Only the gate may be what refuses this call.
      const probeArchivePath = join(archiveDir, "probe.zip");
      writeFileSync(probeArchivePath, exportArchive(store).archive);
      const probeArgs: Record<string, Record<string, unknown>> = {
        ...TOOL_PROBE_ARGS,
        import_memories: { path: probeArchivePath },
      };

      store.setClientEnabled(clientName, false);

      for (const [name, args] of Object.entries(probeArgs)) {
        const { text, isError } = await callTool(client, name, args);
        assert.equal(isError, true, `${name} did not refuse a paused client`);
        assert.ok(!text.includes(LEAK_MARKER), `${name} returned memory content while the client was paused: ${text}`);
      }

      // The resource mirror is the same class of read path that already
      // produced one bypass this milestone (forget's preview) -- it must be
      // gated too, not just the six tools above.
      await assertResourceReadRefused(client, "cairn://memories");
      await assertResourceReadRefused(client, `cairn://memory/${seeded.id}`);

      // Nothing above should have mutated the store: no new remember, no
      // deletion of the seed memory.
      assert.equal(store.list({ limit: 200 }).items.length, 1);
    }, clientName);
  } finally {
    rmSync(archiveDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("the audit log records the connected client's name as source_client", async () => {
  await withServer(async ({ client, store }) => {
    await callJson(client, "remember", { content: "Audit trail check." });
    const log = store.auditLog({ action: "remember" });
    assert.ok(log.items.length > 0);
    assert.equal(log.items[0]?.sourceClient, "cairn-test-client");
  }, "cairn-test-client");
});

test("an MCP client that reports the dashboard's reserved name cannot occupy its clients row, and that row stays pauseable", async () => {
  await withServer(async ({ client, store }) => {
    // The real dashboard registers its own clients row the same way
    // api.ts does: a store call stamped with DASHBOARD_CLIENT as
    // sourceClient, independent of anything the MCP client does below.
    store.list({}, { sourceClient: DASHBOARD_CLIENT });

    await callJson(client, "remember", { content: "Impersonation attempt." });
    const log = store.auditLog({ action: "remember" });
    assert.ok(log.items.length > 0);
    // Not attributed to the reserved dashboard id -- it must never share
    // the dashboard's clients row.
    assert.notEqual(log.items[0]?.sourceClient, DASHBOARD_CLIENT);

    // The dashboard's own row, seeded above, remains a normal, pauseable
    // client row -- the impersonating MCP client never touched it.
    const client_record = store.setClientEnabled(DASHBOARD_CLIENT, false);
    assert.equal(client_record.enabled, false);
  }, DASHBOARD_CLIENT);
});

test("resource list and read work; a mutation triggers resources/list_changed", async () => {
  await withServer(async ({ client }) => {
    const remembered = await callJson<RememberResult>(client, "remember", { content: "Resource-visible memory." });

    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === "cairn://memories"));

    const listRead = await client.readResource({ uri: "cairn://memories" });
    const listText = firstResourceText(listRead.contents);
    assert.ok(listText.length > 0);

    const memRead = await client.readResource({ uri: `cairn://memory/${remembered.id}` });
    const memText = firstResourceText(memRead.contents);
    const parsed = JSON.parse(memText) as { id: string };
    assert.equal(parsed.id, remembered.id);

    let resolveNotified: () => void = () => {};
    const notifiedPromise = new Promise<void>((resolve) => {
      resolveNotified = resolve;
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      resolveNotified();
    });

    await callJson(client, "remember", { content: "Second resource-visible memory." });

    await Promise.race([
      notifiedPromise,
      new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for notifications/resources/list_changed")), 2000);
      }),
    ]);
  });
});

test("a subscribed client receives resources/updated on mutation; an unsubscribed URI does not", async () => {
  await withServer(async ({ client }) => {
    const subscribed = await callJson<RememberResult>(client, "remember", { content: "Subscribed memory." });
    const unsubscribed = await callJson<RememberResult>(client, "remember", { content: "Unsubscribed memory." });
    const subscribedUri = `cairn://memory/${subscribed.id}`;
    const unsubscribedUri = `cairn://memory/${unsubscribed.id}`;

    await client.subscribeResource({ uri: subscribedUri });

    const receivedUris: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      receivedUris.push(notification.params.uri);
    });

    await callJson(client, "update_memory", { id: subscribed.id, content: "Subscribed memory, updated." });
    await callJson(client, "update_memory", { id: unsubscribed.id, content: "Unsubscribed memory, updated." });

    await Promise.race([
      (async () => {
        while (!receivedUris.includes(subscribedUri)) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })(),
      new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for notifications/resources/updated")), 2000);
      }),
    ]);

    assert.ok(receivedUris.includes(subscribedUri), "subscribed URI must receive resources/updated");
    assert.ok(!receivedUris.includes(unsubscribedUri), "an unsubscribed URI must not receive resources/updated");
  });
});

test("works end to end with no embedding provider configured (FTS-only mode)", async () => {
  await withServer(async ({ client }) => {
    const remembered = await callJson<RememberResult>(client, "remember", { content: "FTS-only fact about apples." });
    const recalled = await callJson<RecallResult>(client, "recall", { query: "apples" });
    assert.ok(recalled.hits.some((h) => h.id === remembered.id));
    assert.equal(recalled.degraded, false);
    assert.equal(recalled.degradedReason, null);
  });
});

test("list_memories hides a forgotten memory by default, and reveals it with include_deleted (snake_case and camelCase)", async () => {
  await withServer(async ({ client }) => {
    const remembered = await callJson<RememberResult>(client, "remember", { content: "To be forgotten and reviewed later." });
    await callJson(client, "forget", { id: remembered.id });

    const withoutFlag = await callJson<ListResult>(client, "list_memories", { limit: 200 });
    assert.ok(!withoutFlag.items.some((m) => m.id === remembered.id), "a forgotten memory must be hidden by default");

    const snakeCase = await callJson<ListResult>(client, "list_memories", { limit: 200, include_deleted: true });
    assert.ok(
      snakeCase.items.some((m) => m.id === remembered.id),
      "include_deleted: true must reveal the forgotten memory",
    );

    const camelCase = await callJson<ListResult>(client, "list_memories", { limit: 200, includeDeleted: true });
    assert.ok(
      camelCase.items.some((m) => m.id === remembered.id),
      "includeDeleted (camelCase alias) must also reveal the forgotten memory",
    );
  });
});

// A mutation through server A must reach a client subscribed on server B --
// both created off the same daemon's shared MemoryEventBus -- and must NOT
// reach a client on server C that never subscribed to that URI.
test("a mutation through one server reaches a client subscribed on another sharing the bus, not one that never subscribed", async () => {
  await withSharedBus(async ({ makeClient }) => {
    const a = await makeClient("server-a-client");
    const b = await makeClient("server-b-client");
    const c = await makeClient("server-c-client");
    try {
      const remembered = await callJson<RememberResult>(a.client, "remember", { content: "Shared-bus memory." });
      const uri = `cairn://memory/${remembered.id}`;

      const receivedB: string[] = [];
      b.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
        receivedB.push(notification.params.uri);
      });
      await b.client.subscribeResource({ uri });

      const receivedC: string[] = [];
      c.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
        receivedC.push(notification.params.uri);
      });
      // c deliberately never subscribes.

      await callJson(a.client, "update_memory", { id: remembered.id, content: "Shared-bus memory, updated." });

      await Promise.race([
        (async () => {
          while (!receivedB.includes(uri)) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        })(),
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error("timed out waiting for a cross-session notifications/resources/updated")), 2000);
        }),
      ]);

      assert.ok(receivedB.includes(uri), "the subscribed peer must receive the cross-session notification");
      assert.ok(!receivedC.includes(uri), "a peer that never subscribed must not receive it");
    } finally {
      await a.client.close();
      await a.server.close();
      await b.client.close();
      await b.server.close();
      await c.client.close();
      await c.server.close();
    }
  });
});

test("closing a server unsubscribes it from the shared bus", async () => {
  await withSharedBus(async ({ bus, makeClient }) => {
    const a = await makeClient("server-a-client");
    try {
      const listenersBeforeB = bus.listenerCount;
      const b = await makeClient("server-b-client");
      assert.equal(bus.listenerCount, listenersBeforeB + 1, "creating server B must subscribe it to the bus");

      await b.client.close();
      await b.server.close();

      assert.equal(bus.listenerCount, listenersBeforeB, "closing server B must unsubscribe its bus listener");

      // A mutation through A afterward must not attempt delivery to B's
      // now-closed transport -- proven above by B's listener no longer
      // being registered at all, not merely by the absence of a crash.
      const remembered = await callJson<RememberResult>(a.client, "remember", { content: "After B closed." });
      assert.ok(remembered.id);
    } finally {
      await a.client.close();
      await a.server.close();
    }
  });
});

test("a peer whose transport has already failed does not make the mutating client's write fail", async () => {
  await withSharedBus(async ({ makeClient }) => {
    const a = await makeClient("server-a-client");
    const b = await makeClient("server-b-client");
    try {
      const remembered = await callJson<RememberResult>(a.client, "remember", { content: "Pre-subscribe memory." });
      const uri = `cairn://memory/${remembered.id}`;
      await b.client.subscribeResource({ uri });

      // Simulate B's transport already being gone by the time the
      // cross-session notification tries to reach it -- the scenario the
      // guard in server.ts's bus listener exists for.
      b.server.server.sendResourceUpdated = () => Promise.reject(new Error("simulated dead transport"));

      const { isError, text } = await callTool(a.client, "update_memory", {
        id: remembered.id,
        content: "Updated after B's transport died.",
      });
      assert.equal(isError, false, `a write must not fail because a third party's transport is gone: ${text}`);
    } finally {
      await a.client.close();
      await a.server.close();
      await b.client.close();
      await b.server.close();
    }
  });
});

// The chronology property archive.test.ts defends at the storage layer,
// re-checked here through the MCP layer: export_memories writes a real
// file, and import_memories into a DIFFERENT store must bring the
// memories back with their original ids (BUILD_BRIEF §10 -- created_at is
// derived from the id, so a fresh id on import would collapse the
// original chronology).
test("export_memories then import_memories into a different store round-trips original ids", async () => {
  const sourceDir = makeTempDir();
  const destDir = makeTempDir();
  const sourceStore = openStore({ path: tempDbPath(sourceDir) });
  const destStore = openStore({ path: tempDbPath(destDir) });
  const sourceServer = createMcpServer({ store: sourceStore });
  const destServer = createMcpServer({ store: destStore });
  const sourceClient = new Client({ name: "source-client", version: "1.0.0" });
  const destClient = new Client({ name: "dest-client", version: "1.0.0" });
  const [sourceServerTransport, sourceClientTransport] = InMemoryTransport.createLinkedPair();
  const [destServerTransport, destClientTransport] = InMemoryTransport.createLinkedPair();
  // export_memories confines its writes to CAIRN_HOME, so this test's
  // archive path must live under the temp home it points at.
  const originalHome = process.env.CAIRN_HOME;
  process.env.CAIRN_HOME = sourceDir;
  try {
    await Promise.all([sourceServer.connect(sourceServerTransport), sourceClient.connect(sourceClientTransport)]);
    await Promise.all([destServer.connect(destServerTransport), destClient.connect(destClientTransport)]);

    const first = await callJson<RememberResult>(sourceClient, "remember", { content: "First exported memory." });
    const second = await callJson<RememberResult>(sourceClient, "remember", { content: "Second exported memory." });

    const archivePath = join(sourceDir, "export.zip");
    const exported = await callJson<ExportResult>(sourceClient, "export_memories", { path: archivePath });
    assert.equal(exported.path, archivePath);
    assert.ok(exported.bytes > 0);
    assert.equal(exported.memories, 2);

    const imported = await callJson<ImportResult>(destClient, "import_memories", { path: archivePath });
    assert.equal(imported.imported, 2);
    assert.equal(imported.skipped, 0);

    const destIds = destStore.list({ limit: 200 }).items.map((m) => m.id).sort();
    assert.deepEqual(destIds, [first.id, second.id].sort());

    const again = await callJson<ImportResult>(destClient, "import_memories", { path: archivePath });
    assert.equal(again.imported, 0, "re-importing the same archive must import nothing the second time");
    assert.equal(again.skipped, 2);
  } finally {
    if (originalHome === undefined) {
      delete process.env.CAIRN_HOME;
    } else {
      process.env.CAIRN_HOME = originalHome;
    }
    await sourceClient.close();
    await sourceServer.close();
    await destClient.close();
    await destServer.close();
    sourceStore.close();
    destStore.close();
    try {
      rmSync(sourceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      rmSync(destDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Best-effort: never mask the real failure from fn() with a cleanup error.
    }
  }
});

// export_memories is reachable through ordinary mistaken or prompt-injected
// model behaviour (its own description invites a `path`), so its writes
// must be confined to CAIRN_HOME regardless of what path a caller asks for.
test("export_memories accepts a path inside CAIRN_HOME", async () => {
  const home = makeTempDir();
  const originalHome = process.env.CAIRN_HOME;
  process.env.CAIRN_HOME = home;
  try {
    await withServer(async ({ client }) => {
      const target = join(home, "inside.zip");
      const exported = await callJson<ExportResult>(client, "export_memories", { path: target });
      assert.equal(exported.path, target);
    });
  } finally {
    if (originalHome === undefined) {
      delete process.env.CAIRN_HOME;
    } else {
      process.env.CAIRN_HOME = originalHome;
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

for (const [label, makePath] of Object.entries({
  "relative traversal out of home": (home: string) => join(home, "..", "..", "etc", "passwd"),
  "absolute path outside home": () => "/etc/passwd",
  "sibling directory sharing home's name as a prefix": (home: string) => `${home}-evil/x.zip`,
})) {
  test(`export_memories refuses a path escaping CAIRN_HOME: ${label}`, async () => {
    const home = makeTempDir();
    const originalHome = process.env.CAIRN_HOME;
    process.env.CAIRN_HOME = home;
    try {
      await withServer(async ({ client }) => {
        const target = makePath(home);
        const { isError, text } = await callTool(client, "export_memories", { path: target });
        assert.equal(isError, true, "a path outside CAIRN_HOME must be refused");
        assert.ok(!text.includes(target), "the refusal must not echo the requested path");
        assert.ok(!text.includes("/etc/passwd"), "the refusal must not echo the requested path");
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.CAIRN_HOME;
      } else {
        process.env.CAIRN_HOME = originalHome;
      }
      rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
}

test("import_memories on a nonexistent path returns a clear error, not an unhandled throw", async () => {
  await withServer(async ({ client }) => {
    const { isError, text } = await callTool(client, "import_memories", { path: "/no/such/archive-for-this-test.zip" });
    assert.equal(isError, true, "importing a nonexistent path must return isError: true, not throw unhandled");
    assert.ok(text.length > 0, "the error must say something clear");
  });
});

// A nonexistent path, a directory, and a file that reads fine but is not an
// archive are three DIFFERENT filesystem facts. Returning a different error
// string for each turns import_memories into an existence-and-readability
// oracle over the filesystem for any connected MCP client -- they must
// collapse to one identical, path-free string.
test("import_memories returns the identical error for a nonexistent path, a directory, and a non-archive file", async () => {
  await withServer(async ({ client }) => {
    const dir = makeTempDir();
    try {
      const notArchivePath = join(dir, "not-an-archive.txt");
      writeFileSync(notArchivePath, "just some plain text, not a zip");

      const nonexistent = await callTool(client, "import_memories", { path: "/no/such/archive-for-this-test.zip" });
      const directory = await callTool(client, "import_memories", { path: dir });
      const notArchive = await callTool(client, "import_memories", { path: notArchivePath });

      assert.equal(nonexistent.isError, true);
      assert.equal(directory.isError, true);
      assert.equal(notArchive.isError, true);

      assert.equal(nonexistent.text, directory.text, "nonexistent path and directory must produce the identical error");
      assert.equal(nonexistent.text, notArchive.text, "nonexistent path and non-archive file must produce the identical error");

      assert.ok(!nonexistent.text.includes("/no/such"), "the error must not echo the requested path");
      assert.ok(!directory.text.includes(dir), "the error must not echo the requested path");
      assert.ok(!notArchive.text.includes(notArchivePath), "the error must not echo the requested path");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

test("import_memories refuses a file over the size ceiling, checked with statSync before reading it into memory", async () => {
  await withServer(async ({ client }) => {
    const dir = makeTempDir();
    try {
      const hugePath = join(dir, "huge.zip");
      // A sparse file: truncateSync extends the file's reported size
      // without writing real bytes to disk, so this stays fast regardless
      // of the ceiling's magnitude. What matters is that statSync's
      // reported size alone is enough to refuse it, before readFileSync
      // would ever load it into memory.
      writeFileSync(hugePath, "");
      const oversized = 300 * 1024 * 1024;
      const { truncateSync } = await import("node:fs");
      truncateSync(hugePath, oversized);
      assert.equal(statSync(hugePath).size, oversized);

      const { isError, text } = await callTool(client, "import_memories", { path: hugePath });
      assert.equal(isError, true, "an oversized file must be refused");
      assert.ok(!text.includes(hugePath), "the refusal must not echo the path");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

// Defect 1: export_memories confines writes to the Cairn home, but the
// database itself lives there too. Without an explicit refusal by identity,
// export_memories(path: "cairn.db") truncates the live SQLite file to a ZIP.
test("export_memories refuses to write onto the database, its WAL/SHM siblings, or the runtime file, by name", async () => {
  const home = makeTempDir();
  const originalHome = process.env.CAIRN_HOME;
  process.env.CAIRN_HOME = home;
  try {
    await withServer(async ({ client }) => {
      for (let i = 0; i < 5; i++) {
        await callJson(client, "remember", { content: `Protected-file probe memory ${i}` });
      }
      writeRuntimeFile({ pid: process.pid, port: 1, token: "x", startedAt: Date.now(), version: "test" }, home);

      const db = dbPath(home);
      const runtime = runtimeFilePath(home);
      for (const target of [db, `${db}-wal`, `${db}-shm`, runtime]) {
        const { isError, text } = await callTool(client, "export_memories", { path: target });
        assert.equal(isError, true, `export_memories(path: ${target}) must be refused`);
        assert.ok(!text.includes(home), "the refusal must not echo the path");
      }
    });
  } finally {
    if (originalHome === undefined) {
      delete process.env.CAIRN_HOME;
    } else {
      process.env.CAIRN_HOME = originalHome;
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("export_memories never clobbers an existing file, whatever its name", async () => {
  const home = makeTempDir();
  const originalHome = process.env.CAIRN_HOME;
  process.env.CAIRN_HOME = home;
  try {
    await withServer(async ({ client }) => {
      const target = join(home, "already-here.zip");
      writeFileSync(target, "not a real archive, just occupying the name");

      const { isError, text } = await callTool(client, "export_memories", { path: target });
      assert.equal(isError, true, "exporting onto an existing file must be refused");
      assert.ok(!text.includes(target), "the refusal must not echo the path");
      assert.equal(readFileSync(target, "utf8"), "not a real archive, just occupying the name", "the existing file must be untouched");
    });
  } finally {
    if (originalHome === undefined) {
      delete process.env.CAIRN_HOME;
    } else {
      process.env.CAIRN_HOME = originalHome;
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

// The assertion that matters: after a refused export attempt at the
// database's own path, the database must still open and still hold its
// memories -- not be truncated to a ZIP archive.
test("the database survives a refused export attempt onto its own path", async () => {
  const home = makeTempDir();
  const originalHome = process.env.CAIRN_HOME;
  process.env.CAIRN_HOME = home;
  try {
    const store = openStore({ path: dbPath(home) });
    const server = createMcpServer({ store });
    const client = new Client({ name: "protected-file-client", version: "1.0.0" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      for (let i = 0; i < 5; i++) {
        await callJson(client, "remember", { content: `Survives-refusal probe memory ${i}` });
      }
      const before = store.list({ limit: 200 }).items.length;
      assert.equal(before, 5);

      const { isError } = await callTool(client, "export_memories", { path: dbPath(home) });
      assert.equal(isError, true, "exporting onto the database's own path must be refused");

      const after = store.list({ limit: 200 }).items.length;
      assert.equal(after, before, "the database must still hold every memory after a refused export attempt");
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  } finally {
    if (originalHome === undefined) {
      delete process.env.CAIRN_HOME;
    } else {
      process.env.CAIRN_HOME = originalHome;
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

// Defect 2: exportArchive was called without includeSuperseded, so
// listMemories' default `valid_until IS NULL` filter silently dropped every
// superseded row -- losing the §5/§7 temporal history a backup must
// preserve.
test("export_memories then import_memories preserves a superseded memory and its successor, with validUntil/supersededBy intact", async () => {
  const sourceDir = makeTempDir();
  const destDir = makeTempDir();
  const sourceStore = openStore({ path: tempDbPath(sourceDir) });
  const destStore = openStore({ path: tempDbPath(destDir) });
  const sourceServer = createMcpServer({ store: sourceStore });
  const destServer = createMcpServer({ store: destStore });
  const sourceClient = new Client({ name: "source-client", version: "1.0.0" });
  const destClient = new Client({ name: "dest-client", version: "1.0.0" });
  const [sourceServerTransport, sourceClientTransport] = InMemoryTransport.createLinkedPair();
  const [destServerTransport, destClientTransport] = InMemoryTransport.createLinkedPair();
  const originalHome = process.env.CAIRN_HOME;
  process.env.CAIRN_HOME = sourceDir;
  try {
    await Promise.all([sourceServer.connect(sourceServerTransport), sourceClient.connect(sourceClientTransport)]);
    await Promise.all([destServer.connect(destServerTransport), destClient.connect(destClientTransport)]);

    const munich = await callJson<RememberResult>(sourceClient, "remember", { content: "I live in Munich" });
    const munichBefore = sourceStore.list({ limit: 200 }).items.find((m) => m.id === munich.id);
    assert.ok(munichBefore, "the Munich memory must exist before supersede");

    // Supersede Munich with Berlin the same way the storage layer's own
    // supersede path does: set validUntil + supersededBy on the old row,
    // add the new one.
    const berlin = await callJson<RememberResult>(sourceClient, "remember", { content: "I live in Berlin" });
    sourceStore.db
      .q(`UPDATE memories SET valid_until = ?, superseded_by = ? WHERE id = ?`)
      .run(Date.now(), berlin.id, munich.id);

    const archivePath = join(sourceDir, "supersede-export.zip");
    const exported = await callJson<ExportResult>(sourceClient, "export_memories", { path: archivePath });
    assert.equal(exported.memories, 2);

    const imported = await callJson<ImportResult>(destClient, "import_memories", { path: archivePath });
    assert.equal(imported.imported, 2, "both the superseded memory and its successor must import");

    const destItems = destStore.list({ limit: 200, includeSuperseded: true }).items;
    const destMunich = destItems.find((m) => m.id === munich.id);
    const destBerlin = destItems.find((m) => m.id === berlin.id);
    assert.ok(destMunich, "the superseded Munich memory must survive the round trip");
    assert.ok(destBerlin, "the successor Berlin memory must survive the round trip");
    assert.ok(destMunich.validUntil !== null, "the Munich memory's validUntil must round-trip, not be dropped");
    assert.equal(destMunich.supersededBy, berlin.id, "the Munich memory's supersededBy pointer must round-trip");
  } finally {
    if (originalHome === undefined) {
      delete process.env.CAIRN_HOME;
    } else {
      process.env.CAIRN_HOME = originalHome;
    }
    await sourceClient.close();
    await sourceServer.close();
    await destClient.close();
    await destServer.close();
    sourceStore.close();
    destStore.close();
    rmSync(sourceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    rmSync(destDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
