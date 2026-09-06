// The product-level proof BUILD_BRIEF §13's definition of done names
// explicitly: "an integration test that proves the cross-client shared-store
// flow (write via one MCP session, read via another)" and "the 'tell Claude
// then ask Cursor' demo works end-to-end" (§16.6).
//
// src/shim/shim.test.ts already proves the narrower transport-level claim --
// a real MCP client through the shim (stdio) and a real MCP client direct to
// the daemon (HTTP) share one store -- and this suite does not repeat or
// replace that test. This one is one level up the stack: it launches Cairn
// through the exact entrypoints `cairn setup` wires up (see harness.ts for
// the one substitution it makes and what that substitution does not prove),
// gives the two sessions distinct client identities the way Claude Desktop
// and Cursor actually would, and walks the whole memory lifecycle -- write,
// update, recall, forget, undo, context budgeting, attribution, pause,
// notifications, and daemon-outlives-its-clients -- across them.
//
// Most tests below share ONE daemon (started in `before`, torn down in
// `after`) rather than one per test: nothing about the properties under test
// needs process isolation, every test uses its own scope-unique content so
// results never collide, and starting a fresh daemon (and waiting for a
// fresh CLI process to boot) per test would make this suite slow for no
// benefit. Two tests deliberately break that pattern and say so where they
// do: "the daemon outlives its clients" kills the shared stdio client's
// process (so it must run last among the data tests, after which the shared
// `stdio` handle is no longer usable), and "the generated config is the
// config that works" needs no client or daemon at all.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { makeTempDir } from "../testing/tmp.js";
import { readRuntimeFile } from "../daemon/runtime-file.js";
import { dbPath } from "../config/paths.js";
import { memoryUri } from "../mcp/tools.js";
import { cairnServerEntry } from "../setup/apply.js";
import type { ClientTarget } from "../setup/clients.js";
import {
  callJson,
  cleanupDir,
  cliEntrypoint,
  closeGlobalFetchDispatcher,
  findProjectRoot,
  isPidAlive,
  killPid,
  killTrackedPids,
  listIncludingDeleted,
  readAuditSourceClients,
  readClientStats,
  setClientEnabled,
  startHttpClient,
  startStdioClient,
  trackPid,
  assertRealCairnHomeUntouched,
} from "./harness.js";
import type { HttpClientHandle, StdioClientHandle } from "./harness.js";

interface RememberResult {
  id: string;
  deduped: boolean;
  episodeId: string;
}

interface RecallHit {
  id: string;
  text: string;
  scope: string;
  tags: string[];
}

interface RecallResult {
  hits: RecallHit[];
  degraded: boolean;
}

interface ContextResult {
  text: string;
  memories: { id: string }[];
  tokensEstimated: number;
  truncated: boolean;
}

interface ForgetByIdResult {
  deleted: boolean;
  id: string;
}

// §9-flavoured identities: distinct from each other and from the defaults
// any other test file's client happens to use, so this suite's own audit
// rows/clientStats are never ambiguous with another file's leftovers even if
// a real ~/.cairn were ever (wrongly) shared -- which it never is here, see
// the temp CAIRN_HOME below.
const STDIO_CLIENT_NAME = "claude-desktop-sim";
const HTTP_CLIENT_NAME = "cursor-sim";
const SCOPE = "cross-client-demo";

let home: string;
let stdio: StdioClientHandle;
let http: HttpClientHandle;
let daemonPid: number | undefined;
let daemonUrl: string;
let daemonToken: string;

before(async () => {
  home = makeTempDir();

  // Starting the stdio client first is what proves the §4 auto-start path:
  // nothing has spawned a daemon yet, so this CLI process (running as the
  // shim, per harness.ts) must be the one that does, via ensureDaemon().
  stdio = await startStdioClient(STDIO_CLIENT_NAME, home);

  const info = readRuntimeFile(home);
  assert.ok(info, "the stdio-launched CLI must have auto-started a daemon and written its runtime file");
  daemonPid = info?.pid;
  trackPid(daemonPid);
  daemonUrl = `http://127.0.0.1:${info?.port}`;
  daemonToken = info?.token ?? "";

  http = await startHttpClient(HTTP_CLIENT_NAME, daemonUrl, daemonToken);
});

after(async () => {
  await stdio?.close().catch(() => {});
  await http?.close().catch(() => {});
  await killTrackedPids();
  await killPid(readRuntimeFile(home)?.pid);
  cleanupDir(home);
  await closeGlobalFetchDispatcher();
  assertRealCairnHomeUntouched();
});

test("1. tell one, ask the other -- and back again -- with tags and scope intact", async () => {
  const toldViaStdio = await callJson<RememberResult>(stdio.client, "remember", {
    content: "Cross-client demo: tell Claude, then ask Cursor about the deployment runbook.",
    tags: ["demo", "stdio-origin"],
    scope: SCOPE,
  });

  const askedViaHttp = await callJson<RecallResult>(http.client, "recall", {
    query: "tell Claude then ask Cursor deployment runbook",
    scope: SCOPE,
  });
  const hit = askedViaHttp.hits.find((h) => h.id === toldViaStdio.id);
  assert.ok(hit, "the HTTP client must see what the stdio client remembered");
  assert.equal(hit.scope, SCOPE);
  assert.deepEqual([...hit.tags].sort(), ["demo", "stdio-origin"]);

  const toldViaHttp = await callJson<RememberResult>(http.client, "remember", {
    content: "Cross-client demo: ask Cursor, then tell Claude about the release checklist.",
    tags: ["demo", "http-origin"],
    scope: SCOPE,
  });

  const askedViaStdio = await callJson<RecallResult>(stdio.client, "recall", {
    query: "ask Cursor then tell Claude release checklist",
    scope: SCOPE,
  });
  const hitBack = askedViaStdio.hits.find((h) => h.id === toldViaHttp.id);
  assert.ok(hitBack, "the stdio client must see what the HTTP client remembered");
  assert.equal(hitBack.scope, SCOPE);
  assert.deepEqual([...hitBack.tags].sort(), ["demo", "http-origin"]);
});

test("2. one file: /health and the runtime file agree, and both sessions share the single temp cairn.db", async () => {
  const info = readRuntimeFile(home);
  assert.ok(info);

  const health = (await fetch(`${daemonUrl}/health`).then((res) => res.json())) as { ok: boolean; pid: number };
  assert.equal(health.ok, true);
  assert.equal(health.pid, info?.pid, "the pid /health reports must match the runtime file's pid");

  const expectedDbPath = dbPath(home);
  assert.ok(existsSync(expectedDbPath), "the one db file this daemon was pointed at must exist under the temp CAIRN_HOME");
});

test("3. full lifecycle crosses clients: write, update, recall, forget, and undo", async () => {
  const remembered = await callJson<RememberResult>(stdio.client, "remember", {
    content: "Lifecycle demo: the original text, before any edits.",
    tags: ["lifecycle"],
    scope: SCOPE,
  });

  await callJson(http.client, "update_memory", {
    id: remembered.id,
    content: "Lifecycle demo: the text after the HTTP client's edit.",
  });

  const afterUpdate = await callJson<RecallResult>(stdio.client, "recall", {
    query: "text after the HTTP client's edit",
    scope: SCOPE,
  });
  assert.ok(afterUpdate.hits.some((h) => h.id === remembered.id), "the stdio client must see the HTTP client's update");

  const forgotten = await callJson<ForgetByIdResult>(http.client, "forget", { id: remembered.id });
  assert.equal(forgotten.deleted, true);

  const afterForget = await callJson<RecallResult>(stdio.client, "recall", {
    query: "text after the HTTP client's edit",
    scope: SCOPE,
  });
  assert.ok(
    !afterForget.hits.some((h) => h.id === remembered.id),
    "a memory forgotten by one client must not come back through another client's recall",
  );

  // §5: supersede-not-delete -- a forget is a soft delete, so the row must
  // still exist. list_memories has no include-deleted parameter over MCP
  // yet (see listIncludingDeleted's own doc comment in harness.ts for why
  // this reaches the store directly for just this one assertion).
  const stillThere = listIncludingDeleted(home, { scope: SCOPE }).find((m) => m.id === remembered.id);
  assert.ok(stillThere, "the memory must still exist in the store after forget (soft delete, BUILD_BRIEF §5)");
  assert.ok(stillThere.deletedAt !== null, "and must be marked deleted, not silently left untouched");
});

test("4. get_context on one client includes what the other client wrote, within its token budget", async () => {
  const remembered = await callJson<RememberResult>(stdio.client, "remember", {
    content: "Context budget demo: the deployment process is a blue-green rollout driven by GitHub Actions.",
    tags: ["context-demo"],
    scope: SCOPE,
  });

  const context = await callJson<ContextResult>(http.client, "get_context", {
    query: "deployment process",
    scope: SCOPE,
  });

  assert.ok(
    context.memories.some((m) => m.id === remembered.id),
    "get_context on the HTTP client must include a memory the stdio client wrote",
  );
  // Budgeted, not unbounded (BUILD_BRIEF §8's ~800-token default) -- a
  // generous ceiling above the default so this isn't tied to the exact
  // tokenizer, while still catching "the whole store got dumped in".
  assert.ok(context.tokensEstimated <= 1200, "get_context must stay within its budget, never dump the whole store");
});

test("5. attribution: the access log and clientStats split both client identities", async () => {
  await callJson(stdio.client, "remember", { content: "Attribution demo: written by the stdio client.", scope: SCOPE });
  await callJson(http.client, "recall", { query: "Attribution demo", scope: SCOPE });

  const sourceClients = readAuditSourceClients(home);
  assert.ok(sourceClients.includes(STDIO_CLIENT_NAME), "the access log must show the stdio client's own identity");
  assert.ok(sourceClients.includes(HTTP_CLIENT_NAME), "the access log must show the HTTP client's own identity");

  const stats = readClientStats(home);
  const stdioStats = stats.find((s) => s.sourceClient === STDIO_CLIENT_NAME);
  const httpStats = stats.find((s) => s.sourceClient === HTTP_CLIENT_NAME);
  assert.ok(stdioStats && stdioStats.writes > 0, "clientStats must attribute writes to the stdio client");
  assert.ok(httpStats && httpStats.reads > 0, "clientStats must attribute reads to the HTTP client, split from the stdio client's");
});

test("6. per-app pause refuses only the paused client's calls, and only until it is resumed", async () => {
  setClientEnabled(home, HTTP_CLIENT_NAME, false);
  try {
    await assert.rejects(
      () => callJson(http.client, "recall", { query: "anything", scope: SCOPE }),
      /disabled/,
      "a paused client's own calls must be refused",
    );

    const stillWorks = await callJson<RememberResult>(stdio.client, "remember", {
      content: "Pause demo: an unrelated client must keep working while another one is paused.",
      scope: SCOPE,
    });
    assert.ok(stillWorks.id, "pausing one client must not affect a different client");

    const workedAgain = await (async () => {
      setClientEnabled(home, HTTP_CLIENT_NAME, true);
      return callJson<RecallResult>(http.client, "recall", { query: "Pause demo", scope: SCOPE });
    })();
    assert.ok(
      workedAgain.hits.some((h) => h.id === stillWorks.id),
      "re-enabling the client must let its calls through again",
    );
  } finally {
    // Idempotent: already re-enabled above on the success path, but this
    // guarantees the client is left enabled even if an assertion above threw.
    setClientEnabled(home, HTTP_CLIENT_NAME, true);
  }
});

test("7. a mutation from one client reaches the other, over its own session, as a resource notification it subscribed to", async () => {
  const remembered = await callJson<RememberResult>(stdio.client, "remember", {
    content: "Notification demo: about to be updated by the stdio client.",
    scope: SCOPE,
  });
  const uri = memoryUri(remembered.id);

  const receivedUris: string[] = [];
  http.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
    receivedUris.push(notification.params.uri);
  });
  await http.client.subscribeResource({ uri });

  await callJson(stdio.client, "update_memory", {
    id: remembered.id,
    content: "Notification demo: now updated by the stdio client.",
  });

  await Promise.race([
    (async () => {
      while (!receivedUris.includes(uri)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })(),
    new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(new Error("timed out waiting for notifications/resources/updated to cross sessions")), 5000);
    }),
  ]);
});

test("8. the daemon outlives its clients: killing the stdio client's process leaves the daemon and the HTTP client alive, and a new stdio client still sees the memories", async () => {
  const remembered = await callJson<RememberResult>(stdio.client, "remember", {
    content: "Outlives demo: written before the original stdio client's process is killed.",
    scope: SCOPE,
  });

  const shimPid = stdio.pid;
  assert.ok(shimPid, "the stdio client's own (shim) process must have a pid to kill");
  await killPid(shimPid);

  const health = await fetch(`${daemonUrl}/health`);
  assert.equal(health.status, 200, "the daemon must keep answering /health after its stdio client's process dies");
  assert.ok(
    daemonPid !== undefined && isPidAlive(daemonPid),
    "the daemon process itself (a separate, detached process from the shim) must still be alive",
  );

  const stillRecalls = await callJson<RecallResult>(http.client, "recall", { query: "Outlives demo", scope: SCOPE });
  assert.ok(
    stillRecalls.hits.some((h) => h.id === remembered.id),
    "the HTTP client must keep working after the stdio client's process dies",
  );

  const freshStdio = await startStdioClient(STDIO_CLIENT_NAME, home);
  try {
    const seenByFresh = await callJson<RecallResult>(freshStdio.client, "recall", { query: "Outlives demo", scope: SCOPE });
    assert.ok(
      seenByFresh.hits.some((h) => h.id === remembered.id),
      "a brand-new stdio client attaching later must still see memories written before it existed -- the user never manages a service",
    );
  } finally {
    await freshStdio.close().catch(() => {});
    await killPid(freshStdio.pid);
  }
});

test("9. the generated config is the config that works: cairnServerEntry names the entrypoint this suite actually spawns", () => {
  const target: ClientTarget = {
    id: "claude-desktop",
    name: "Claude Desktop",
    configPath: join(home, "unused-claude-desktop-config.json"),
    transport: "stdio",
    detected: true,
  };
  const entry = cairnServerEntry(target);

  // BUILD_BRIEF §11's documented stdio snippet, verbatim.
  assert.deepEqual(entry, { command: "npx", args: ["-y", "cairn-mem@latest"] });

  // Closing the loop harness.ts's own header comment names: the "npx"
  // command above is a stand-in for this project's own package, and
  // package.json's `bin.cairn` is what `npx cairn-mem` ultimately resolves to.
  // Deriving the expected path from package.json itself (not a hardcoded
  // relative depth) is what proves the two ends of that substitution still
  // agree, rather than merely asserting harness.ts agrees with itself.
  const root = findProjectRoot();
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin?: Record<string, string> };
  const binRelative = pkg.bin?.cairn;
  assert.ok(binRelative, "package.json must declare a cairn bin entry for the npx substitution to name");
  const expectedEntrypoint = join(root, binRelative);

  assert.equal(
    cliEntrypoint(),
    expectedEntrypoint,
    "the entrypoint this suite spawns (harness.ts's cliEntrypoint()) must be the same file package.json's bin.cairn names",
  );
});

// Every other test above proves the shared-store claim across ONE stdio
// client and ONE HTTP client -- the shape src/shim/shim.test.ts already
// covers too. §13's demo names two stdio hosts (Claude Desktop, Cursor), so
// the shim<->daemon transport itself needs proving twice, from two
// independent OS processes, neither of which spawned the other's daemon.
// This test owns its own temp CAIRN_HOME and its own daemon (never the
// shared `home`/`stdio`/`http` fixtures above) so a failure or a leak here
// can never be confused with theirs, and so it can kill its daemon itself
// in its own `finally` rather than relying on the file-level `after()`.
//
// Note on coverage: like every other test in this file, this one goes
// through harness.ts's `startStdioClient`, which pins `CAIRN_PORT=0` --
// so this proves two stdio shims sharing a daemon on an OS-assigned
// ephemeral port, not the fixed-port-already-in-use branch.
function findLinuxDaemonPidsForHome(home: string): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      if (!cmdline.includes("daemon/main.js")) {
        continue;
      }
      const environ = readFileSync(`/proc/${entry}/environ`, "utf8");
      if (environ.split("\0").includes(`CAIRN_HOME=${home}`)) {
        pids.push(Number(entry));
      }
    } catch {
      // The process exited between readdir and read, or /proc/<pid>/environ
      // is unreadable (not this user's process) -- either way, skip it.
    }
  }
  return pids;
}

test(
  "10. two independent stdio shim PROCESSES share one daemon, in both directions, with correct per-client attribution",
  { timeout: 30_000 },
  async (t) => {
    if (process.platform === "win32") {
      t.skip("this test's daemon-count proof reads /proc, which does not exist on Windows");
      return;
    }

    const TWO_STDIO_SCOPE = "two-stdio-demo";
    const CLIENT_A_NAME = "claude-desktop-two-stdio";
    const CLIENT_B_NAME = "cursor-two-stdio";

    const twoStdioHome = makeTempDir();
    let clientA: StdioClientHandle | undefined;
    let clientB: StdioClientHandle | undefined;
    let twoStdioDaemonPid: number | undefined;

    try {
      // Nothing has started a daemon under this home yet, so this first
      // process must be the one that auto-starts it (BUILD_BRIEF §4).
      clientA = await startStdioClient(CLIENT_A_NAME, twoStdioHome);

      const infoAfterA = readRuntimeFile(twoStdioHome);
      assert.ok(infoAfterA, "the first stdio process must have auto-started a daemon and written its runtime file");
      twoStdioDaemonPid = infoAfterA?.pid;
      trackPid(twoStdioDaemonPid);

      // The second stdio process must find that daemon already alive
      // (ensureDaemon's existing+isDaemonAlive branch) and attach to it
      // rather than spawning its own.
      clientB = await startStdioClient(CLIENT_B_NAME, twoStdioHome);

      const infoAfterB = readRuntimeFile(twoStdioHome);
      assert.ok(infoAfterB);
      assert.equal(infoAfterB?.pid, infoAfterA?.pid, "both stdio processes must resolve to the same daemon pid");
      assert.equal(infoAfterB?.port, infoAfterA?.port, "both stdio processes must resolve to the same daemon port");
      assert.notEqual(clientA.pid, clientB.pid, "the two stdio (shim) processes themselves must be distinct processes");

      const daemonPids = findLinuxDaemonPidsForHome(twoStdioHome);
      assert.deepEqual(daemonPids, [twoStdioDaemonPid], "exactly one daemon process must exist for this CAIRN_HOME");

      // 2. write through A, read through B.
      const toldViaA = await callJson<RememberResult>(clientA.client, "remember", {
        content: "Two-stdio demo: written by client A, must be readable by client B.",
        tags: ["two-stdio"],
        scope: TWO_STDIO_SCOPE,
      });
      const seenByB = await callJson<RecallResult>(clientB.client, "recall", {
        query: "written by client A must be readable by client B",
        scope: TWO_STDIO_SCOPE,
      });
      assert.ok(
        seenByB.hits.some((h) => h.id === toldViaA.id),
        "client B (a second, independent stdio process) must see what client A wrote",
      );

      // 3. write back through B, read through A -- so the direction is not
      // accidentally one-way.
      const toldViaB = await callJson<RememberResult>(clientB.client, "remember", {
        content: "Two-stdio demo: written by client B, must be readable by client A.",
        tags: ["two-stdio"],
        scope: TWO_STDIO_SCOPE,
      });
      const seenByA = await callJson<RecallResult>(clientA.client, "recall", {
        query: "written by client B must be readable by client A",
        scope: TWO_STDIO_SCOPE,
      });
      assert.ok(
        seenByA.hits.some((h) => h.id === toldViaB.id),
        "client A must see what client B wrote back, so the shared store is proven in both directions",
      );

      // 4. cross-client attribution: each memory belongs to the stdio
      // process that actually wrote it (BUILD_BRIEF §9's "Connected apps"
      // and per-client pause both depend on this).
      const stats = readClientStats(twoStdioHome);
      const statsA = stats.find((s) => s.sourceClient === CLIENT_A_NAME);
      const statsB = stats.find((s) => s.sourceClient === CLIENT_B_NAME);
      assert.ok(statsA && statsA.writes > 0, "clientStats must attribute client A's write to client A's own identity");
      assert.ok(statsB && statsB.writes > 0, "clientStats must attribute client B's write to client B's own identity");

      const sourceClients = readAuditSourceClients(twoStdioHome);
      assert.ok(sourceClients.includes(CLIENT_A_NAME), "the access log must show client A's own stdio identity");
      assert.ok(sourceClients.includes(CLIENT_B_NAME), "the access log must show client B's own stdio identity");
    } finally {
      await clientA?.close().catch(() => {});
      await clientB?.close().catch(() => {});
      await killPid(clientA?.pid);
      await killPid(clientB?.pid);
      await killPid(twoStdioDaemonPid);
      cleanupDir(twoStdioHome);
    }
  },
);
