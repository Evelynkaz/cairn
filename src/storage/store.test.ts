import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { withTempDir, makeTempDir, tempDbPath } from "../testing/tmp.js";
import { openStore } from "./store.js";
import type { CallContext, Store } from "./store.js";
import { setPrivacyMode } from "./privacy-settings.js";
import { ensureVectorSpace, upsertVector } from "./repositories/vectors.js";
import type { CairnDb } from "./db.js";

function withStore<T>(fn: (store: Store, dir: string) => T): T {
  return withTempDir((dir) => {
    const store = openStore({ path: tempDbPath(dir) });
    try {
      return fn(store, dir);
    } finally {
      store.close();
    }
  });
}

// withTempDir's try/finally does not await a Promise `fn` returns before
// running its cleanup, so an async body (needed now that recall()/context()
// are async) would have its temp dir removed and its store closed while
// still in flight. This variant awaits `fn` itself before cleaning up.
async function withStoreAsync<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const dir = makeTempDir();
  const store = openStore({ path: tempDbPath(dir) });
  try {
    return await fn(store);
  } finally {
    store.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Best-effort: never mask the real failure from fn() with a cleanup error.
    }
  }
}

function countRows(store: Store, table: string): number {
  const row = store.db.q(`select count(*) as c from ${table}`).get();
  return row ? Number(row["c"]) : 0;
}

function accessCount(store: Store, id: string): number {
  const row = store.db.q(`select access_count as c from memories where id = ?`).get(id);
  return row ? Number(row["c"]) : -1;
}

// Forces the next Date.now() to land on a later millisecond, so a
// created_at derived from uuidv7() right after this call is guaranteed to
// be strictly greater than one taken right before it.
function waitForNextMs(): void {
  const start = Date.now();
  while (Date.now() === start) {
    // busy-wait
  }
}

test("remember appends an episode, creates a linked memory, and records an audit row", () => {
  withStore((store) => {
    const { memory, deduped, episodeId } = store.remember({
      content: "the sky is blue",
      tags: ["fact"],
    });

    assert.equal(deduped, false);
    assert.equal(memory.episodeId, episodeId);

    assert.equal(countRows(store, "episodes"), 1);
    assert.equal(countRows(store, "memories"), 1);

    const { items } = store.auditLog({ action: "remember" });
    assert.equal(items.length, 1);
    assert.equal(items[0]?.memoryId, memory.id);
  });
});

test("remember is atomic: an invalid importance leaves no episode, no memory, no audit row", () => {
  withStore((store) => {
    assert.throws(() => store.remember({ content: "bad importance", importance: 5 }));

    assert.equal(countRows(store, "episodes"), 0);
    assert.equal(countRows(store, "memories"), 0);
    assert.equal(countRows(store, "audit_log"), 0);
  });
});

test("re-remembering the same text dedupes the memory but appends a second episode", () => {
  withStore((store) => {
    const first = store.remember({ content: "repeat me" });
    const second = store.remember({ content: "repeat me" });

    assert.equal(first.deduped, false);
    assert.equal(second.deduped, true);
    assert.equal(second.memory.id, first.memory.id);
    // The memory already carried an episode from the first write, so the
    // dedupe path does not reattach it to the second episode -- but the
    // second episode is still appended to the log regardless.
    assert.equal(second.episodeId, first.episodeId);
    assert.equal(second.memory.episodeId, first.episodeId);

    assert.equal(countRows(store, "memories"), 1);
    assert.equal(countRows(store, "episodes"), 2);
  });
});

test("get records a read audit event, increments access_count, and leaves updated_at unchanged", () => {
  withStore((store) => {
    const { memory } = store.remember({ content: "read me" });
    assert.equal(memory.accessCount, 0);

    const fetched = store.get(memory.id);
    assert.ok(fetched);
    assert.equal(fetched.accessCount, 1);
    assert.equal(fetched.updatedAt, memory.updatedAt);

    const { items } = store.auditLog({ action: "list_memories" });
    const readEvent = items.find((e) => e.memoryId === memory.id);
    assert.ok(readEvent);
    assert.equal(readEvent.resultCount, 1);
  });
});

// Every public method on Store that reads or mutates memory data on behalf
// of a calling client must go through the gate() function in store.ts, so a
// disabled client is refused on all of them, not just remember(). One
// method (get) shipped without the gate call before; a test that only
// exercised remember() would never have caught that. Drive coverage from
// this table instead: adding a gated-looking method to Store without also
// adding it here fails the allow-list test below, and adding it here
// without actually gating it in store.ts fails the refusal test.
type GatedInvoke = (store: Store, id: string, ctx: CallContext) => unknown;

const GATED_METHODS: Record<string, GatedInvoke> = {
  remember: (store, _id, ctx) => store.remember({ content: "gate probe" }, ctx),
  get: (store, id, ctx) => store.get(id, {}, ctx),
  list: (store, _id, ctx) => store.list({}, ctx),
  recall: (store, _id, ctx) => store.recall("gate probe", {}, ctx),
  context: (store, _id, ctx) => store.context("gate probe", {}, ctx),
  update: (store, id, ctx) => store.update(id, { text: "gate probe" }, ctx),
  forget: (store, id, ctx) => store.forget(id, ctx),
  forgetWhere: (store, _id, ctx) => store.forgetWhere("gate probe", {}, ctx),
  restore: (store, id, ctx) => store.restore(id, ctx),
  supersede: (store, id, ctx) => store.supersede(id, { text: "gate probe" }, ctx),
  asOf: (store, _id, ctx) => store.asOf(Date.now(), {}, ctx),
  deleteEverything: (store, _id, ctx) => store.deleteEverything({ confirm: true }, ctx),
  episodes: (store, _id, ctx) => store.episodes({}, ctx),
  episode: (store, id, ctx) => store.episode(id, ctx),
};

// Deliberately ungated -- administrative/dashboard-side surface, not
// traffic that arrives with a ctx.sourceClient to check:
//   db               - internal handle exposed for tests/migration tooling only
//   capabilities     - static driver info, not a query over stored data
//   close            - connection lifecycle, not something a client calls
//   clients          - the dashboard's own list of connected clients
//   setClientEnabled - the pause/unpause control itself, not client traffic
//   auditLog         - the dashboard's access-log view
//   clientStats      - the dashboard's per-client activity view
//   countMemories    - the daemon's unauthenticated /health probe (server.ts);
//                      it never receives a ctx.sourceClient to gate on, by
//                      design (see /health's own no-auth comment)
// Adding a name here is a conscious call that the member is not client
// traffic; it is not a place to silently exempt a new read/write method.
const DELIBERATELY_UNGATED = new Set([
  "db",
  "capabilities",
  "close",
  "clients",
  "setClientEnabled",
  "auditLog",
  "clientStats",
  "countMemories",
]);

test("the gated-method table matches the store's actual surface exactly", () => {
  withStore((store) => {
    const actual = new Set(Object.keys(store));
    const expected = new Set([...Object.keys(GATED_METHODS), ...DELIBERATELY_UNGATED]);
    assert.deepEqual([...actual].sort(), [...expected].sort());
  });
});

test("every gated method refuses a disabled client and records the refusal in the audit log", async () => {
  for (const [name, invoke] of Object.entries(GATED_METHODS)) {
    await withStoreAsync(async (store) => {
      const clientId = `paused-${name}`;
      // Register the client first via a harmless read.
      store.list({}, { sourceClient: clientId });
      store.setClientEnabled(clientId, false);

      const before = store.clientStats().find((s) => s.sourceClient === clientId);
      // assert.rejects (not assert.throws) because two of these methods
      // (recall, context) are async: gate() still throws synchronously
      // inside them, but an async function turns that into a rejected
      // Promise rather than a synchronous throw, so a uniform check needs
      // to await either shape.
      await assert.rejects(
        async () => {
          await invoke(store, "does-not-exist", { sourceClient: clientId });
        },
        new RegExp(clientId),
        `${name}() did not refuse a disabled client`,
      );

      const refusals = store.auditLog({ refused: true, sourceClient: clientId });
      assert.equal(refusals.items.length, 1, `${name}() did not audit its refusal`);

      const after = store.clientStats().find((s) => s.sourceClient === clientId);
      assert.deepEqual(
        after,
        before,
        `${name}()'s refusal must not count as activity`,
      );
    });
  }
});

test("a disabled client is refused on remember and the refusal is audited; re-enabling lets it through", () => {
  withStore((store) => {
    // Register the client first via a harmless read.
    store.list({}, { sourceClient: "paused-app" });
    store.setClientEnabled("paused-app", false);

    assert.throws(
      () => store.remember({ content: "should be blocked" }, { sourceClient: "paused-app" }),
      /paused-app/,
    );

    const { items } = store.auditLog({ action: "remember", sourceClient: "paused-app" });
    assert.equal(items.length, 1);
    assert.equal(items[0]?.details?.["refused"], true);
    assert.equal(countRows(store, "memories"), 0);

    store.setClientEnabled("paused-app", true);
    const { memory } = store.remember({ content: "now allowed" }, { sourceClient: "paused-app" });
    assert.ok(memory);
  });
});

test("an operation with no sourceClient is never blocked, even while another client is disabled", () => {
  withStore((store) => {
    store.list({}, { sourceClient: "paused-app-2" });
    store.setClientEnabled("paused-app-2", false);

    const clientsBefore = countRows(store, "clients");
    const { memory } = store.remember({ content: "anonymous write" });
    assert.ok(memory);

    // No client row for a null/anonymous sourceClient, and no refusal was
    // recorded -- an anonymous call is not gated at all.
    assert.equal(countRows(store, "clients"), clientsBefore);
    assert.equal(store.auditLog({ refused: true }).items.length, 0);
  });
});

test("clients() lists a client seen only through ctx.sourceClient", () => {
  withStore((store) => {
    const { memory } = store.remember({ content: "for the read test" });
    store.get(memory.id, {}, { sourceClient: "reader-only" });

    const clients = store.clients();
    assert.ok(clients.some((c) => c.id === "reader-only"));
  });
});

test("clientStats splits reads and writes for a client that did both", () => {
  withStore((store) => {
    store.remember({ content: "write op" }, { sourceClient: "both-app" });
    store.list({}, { sourceClient: "both-app" });

    const stats = store.clientStats();
    const entry = stats.find((s) => s.sourceClient === "both-app");
    assert.ok(entry);
    assert.equal(entry.writes, 1);
    assert.equal(entry.reads, 1);
  });
});

test("a read-only store refuses mutating methods and still serves get/list", () => {
  withTempDir((dir) => {
    const path = tempDbPath(dir);
    const writable = openStore({ path });
    const { memory } = writable.remember({ content: "seed data" });
    writable.close();

    const readOnlyStore = openStore({ path, readOnly: true });
    try {
      assert.throws(() => readOnlyStore.remember({ content: "nope" }), /read-only/);
      assert.throws(() => readOnlyStore.update(memory.id, { text: "nope" }), /read-only/);
      assert.throws(() => readOnlyStore.forget(memory.id), /read-only/);

      const fetched = readOnlyStore.get(memory.id);
      assert.equal(fetched?.id, memory.id);

      const { items } = readOnlyStore.list();
      assert.equal(items.length, 1);
    } finally {
      readOnlyStore.close();
    }
  });
});

test("a disabled client is refused on recall and get_context; the refusal is recorded with refused: true", async () => {
  await withStoreAsync(async (store) => {
    store.remember({ content: "gated retrieval fact" });
    // Register the client first via a harmless read.
    store.list({}, { sourceClient: "paused-retrieval" });
    store.setClientEnabled("paused-retrieval", false);
    const before = store.clientStats().find((s) => s.sourceClient === "paused-retrieval");

    await assert.rejects(
      () => store.recall("gated retrieval fact", {}, { sourceClient: "paused-retrieval" }),
      /paused-retrieval/,
    );
    await assert.rejects(
      () => store.context("gated retrieval fact", {}, { sourceClient: "paused-retrieval" }),
      /paused-retrieval/,
    );

    const refusals = store.auditLog({ refused: true, sourceClient: "paused-retrieval" });
    assert.equal(refusals.items.length, 2);
    assert.ok(refusals.items.every((e) => e.refused === true));

    // A refusal is not activity: it must not show up in clientStats.
    const after = store.clientStats().find((s) => s.sourceClient === "paused-retrieval");
    assert.deepEqual(after, before);
  });
});

test("store.recall audits as \"recall\" with resultCount; store.context audits as \"get_context\"", async () => {
  await withStoreAsync(async (store) => {
    store.remember({ content: "hybrid retrieval fact about kubernetes deployment" });

    const result = await store.recall("kubernetes deployment");
    assert.ok(result.hits.length > 0);
    const recallEvents = store.auditLog({ action: "recall" });
    assert.equal(recallEvents.items.length, 1);
    assert.equal(recallEvents.items[0]?.resultCount, result.hits.length);

    const block = await store.context("kubernetes deployment");
    const contextEvents = store.auditLog({ action: "get_context" });
    assert.equal(contextEvents.items.length, 1);
    assert.equal(contextEvents.items[0]?.resultCount, block.memories.length);
  });
});

test("a read-only store serves recall and context without gating, and records no audit for them", async () => {
  const dir = makeTempDir();
  const path = tempDbPath(dir);
  try {
    const writable = openStore({ path });
    writable.remember({ content: "read-only recall target" });
    writable.close();

    const readOnlyStore = openStore({ path, readOnly: true });
    try {
      const recalled = await readOnlyStore.recall("read-only recall target");
      assert.ok(recalled.hits.some((h) => h.text === "read-only recall target"));

      const block = await readOnlyStore.context("read-only recall target");
      assert.ok(block.memories.length > 0);

      // recordAudit is itself a write; a read-only connection cannot
      // perform one, so -- exactly like every other read on this store
      // (get/list/asOf/episodes/episode) -- recall/context silently skip
      // auditing here rather than throwing. This is a deliberate choice,
      // not an oversight: see the matching comment in store.ts.
      assert.equal(readOnlyStore.auditLog({ action: "recall" }).items.length, 0);
      assert.equal(readOnlyStore.auditLog({ action: "get_context" }).items.length, 0);
    } finally {
      readOnlyStore.close();
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Best-effort: never mask the real failure from fn() with a cleanup error.
    }
  }
});

test("update is atomic: a poisoned audit insert leaves the mutation and log both untouched", () => {
  withStore((store) => {
    const { memory } = store.remember({ content: "before" });
    store.db.exec(
      `CREATE TRIGGER poison BEFORE INSERT ON audit_log
       WHEN new.action = 'update_memory'
       BEGIN SELECT RAISE(ABORT, 'x'); END`,
    );

    assert.throws(() => store.update(memory.id, { text: "after" }));

    const fetched = store.get(memory.id);
    assert.equal(fetched?.text, "before");
    assert.equal(store.auditLog({ action: "update_memory" }).items.length, 0);

    // The store must still be usable after the rolled-back transaction.
    store.db.exec(`DROP TRIGGER poison`);
    const updated = store.update(memory.id, { text: "after" });
    assert.equal(updated.text, "after");
  });
});

test("supersede through the Store audits the old id and keeps both rows", () => {
  withStore((store) => {
    const { memory: original } = store.remember({ content: "v1" });
    const { superseded, replacement } = store.supersede(original.id, { text: "v2" });

    assert.equal(superseded.id, original.id);
    assert.equal(superseded.supersededBy, replacement.id);

    const events = store.auditLog({ action: "update_memory", memoryId: original.id });
    assert.equal(events.items.length, 1);
    assert.equal(events.items[0]?.details?.["supersededBy"], replacement.id);

    assert.ok(store.get(original.id, { includeSuperseded: true }));
    assert.ok(store.get(replacement.id));
  });
});

test("asOf through the Store returns the pre-supersede snapshot", () => {
  withStore((store) => {
    const { memory: original } = store.remember({ content: "old text" });
    waitForNextMs();
    const beforeSupersede = Date.now();
    const { replacement } = store.supersede(original.id, { text: "new text" });

    const snapshot = store.asOf(beforeSupersede - 1);
    const found = snapshot.find((m) => m.id === original.id);
    assert.ok(found);
    assert.equal(found.text, "old text");
    assert.ok(!snapshot.some((m) => m.id === replacement.id));
  });
});

test("restore conflict through the Store names both ids, not a generic transaction error", () => {
  withStore((store) => {
    const { memory: original } = store.remember({ content: "conflict text" });
    store.forget(original.id);
    const { memory: replacement } = store.remember({ content: "conflict text" });

    try {
      store.restore(original.id);
      assert.fail("expected restore to throw");
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(original.id));
      assert.ok(error.message.includes(replacement.id));
      assert.ok(!error.message.includes("rollback-only"));
    }
  });
});

test("forget then get: undefined by default, the row with includeDeleted, no access_count bump", () => {
  withStore((store) => {
    const { memory } = store.remember({ content: "please forget me" });
    store.forget(memory.id);

    const hidden = store.get(memory.id);
    assert.equal(hidden, undefined);
    assert.equal(accessCount(store, memory.id), 0);

    const revealed = store.get(memory.id, { includeDeleted: true });
    assert.ok(revealed);
    assert.equal(revealed.text, "please forget me");
    assert.ok(revealed.deletedAt !== null);
  });
});

test("forgetWhere: without confirm deletes nothing and returns matches; confirm: true deletes them", async () => {
  await withStoreAsync(async (store) => {
    store.remember({ content: "forgetWhere target about the old job at Acme" });
    store.remember({ content: "another note about the old job at Acme" });
    store.remember({ content: "unrelated fact about pizza" });

    const preview = await store.forgetWhere("old job at Acme", {});
    assert.equal(preview.deleted, false);
    assert.equal(preview.count, 0);
    assert.ok(preview.matches.length >= 2);
    assert.equal(countRows(store, "memories"), 3);

    const confirmed = await store.forgetWhere("old job at Acme", { confirm: true });
    assert.equal(confirmed.deleted, true);
    assert.equal(confirmed.count, preview.matches.length);
    assert.equal(confirmed.matches.length, confirmed.count);
    for (const match of confirmed.matches) {
      assert.equal(store.get(match.id), undefined);
    }
    assert.equal(countRows(store, "memories"), 3);
    assert.equal(store.list({ limit: 200 }).items.length, 3 - confirmed.count);
  });
});

test("forgetWhere refuses a disabled client on both the preview and the confirmed form; the refusal is audited as refused: true and not counted in clientStats", async () => {
  await withStoreAsync(async (store) => {
    store.remember({ content: "gated forgetWhere fact" });
    store.list({}, { sourceClient: "paused-forget-where" });
    store.setClientEnabled("paused-forget-where", false);
    const before = store.clientStats().find((s) => s.sourceClient === "paused-forget-where");

    await assert.rejects(
      () => store.forgetWhere("gated forgetWhere fact", {}, { sourceClient: "paused-forget-where" }),
      /paused-forget-where/,
    );
    await assert.rejects(
      () => store.forgetWhere("gated forgetWhere fact", { confirm: true }, { sourceClient: "paused-forget-where" }),
      /paused-forget-where/,
    );

    const refusals = store.auditLog({ refused: true, sourceClient: "paused-forget-where" });
    assert.equal(refusals.items.length, 2);
    assert.ok(refusals.items.every((e) => e.refused === true));

    const after = store.clientStats().find((s) => s.sourceClient === "paused-forget-where");
    assert.deepEqual(after, before);
    assert.equal(countRows(store, "memories"), 1);
  });
});

test("refused calls do not count as activity in clientStats but remain in auditLog({ refused: true })", () => {
  withStore((store) => {
    store.list({}, { sourceClient: "n-refused" });
    store.setClientEnabled("n-refused", false);
    waitForNextMs();
    const since = Date.now();

    for (let i = 0; i < 3; i++) {
      assert.throws(() =>
        store.remember({ content: `blocked ${i}` }, { sourceClient: "n-refused" }),
      );
    }

    const stats = store.clientStats({ since });
    const entry = stats.find((s) => s.sourceClient === "n-refused");
    assert.ok(!entry || (entry.reads === 0 && entry.writes === 0));

    const refusals = store.auditLog({ refused: true, sourceClient: "n-refused" });
    assert.equal(refusals.items.length, 3);
  });
});

test("audit rows for by-id operations carry the memory's own scope, not ctx.scope", () => {
  withStore((store) => {
    const { memory } = store.remember({ content: "scoped fact", scope: "default" });

    store.get(memory.id, {}, { scope: "work" });
    store.update(memory.id, { importance: 0.9 }, { scope: "work" });

    const getEvent = store.auditLog({ action: "list_memories", memoryId: memory.id }).items[0];
    assert.equal(getEvent?.scope, "default");

    const updateEvent = store.auditLog({ action: "update_memory", memoryId: memory.id }).items[0];
    assert.equal(updateEvent?.scope, "default");
  });
});

test("episodes() and episode(id) return what remember appended", () => {
  withStore((store) => {
    const { episodeId } = store.remember({ content: "episodic content", scope: "default" });

    const single = store.episode(episodeId);
    assert.ok(single);
    assert.equal(single.content, "episodic content");

    const { items } = store.episodes({ scope: "default" });
    assert.ok(items.some((e) => e.id === episodeId));
  });
});

test("countMemories: matches list()'s default live predicate and respects scope", () => {
  withStore((store) => {
    assert.equal(store.countMemories(), 0);

    const a = store.remember({ content: "counted memory one", scope: "work" });
    store.remember({ content: "counted memory two", scope: "personal" });
    assert.equal(store.countMemories(), 2);
    assert.equal(store.countMemories({ scope: "work" }), 1);
    assert.equal(store.countMemories({ scope: "personal" }), 1);

    store.forget(a.memory.id);
    assert.equal(store.countMemories(), 1);
    assert.equal(store.countMemories({ scope: "work" }), 0);

    const { memory: b } = store.remember({ content: "will be superseded" });
    store.supersede(b.id, { text: "superseded replacement" });
    // supersede adds a replacement row, so the net live count only drops
    // for the one just-forgotten memory above, not for b.
    assert.equal(store.countMemories(), 2);
  });
});

test("close() is idempotent", () => {
  withTempDir((dir) => {
    const store = openStore({ path: tempDbPath(dir) });
    store.close();
    assert.doesNotThrow(() => store.close());
  });
});

// Synthetic secrets shaped to match ../privacy/detectors.ts, kept alnum-only
// so an FTS5 MATCH query against them is well-formed.
const AWS_KEY = "AKIAABCDEFGHIJKLMNOP";
const GH_TOKEN = "ghp_" + "a".repeat(40);

// Walks every table in the database, including the FTS5 shadow tables
// (memories_fts_data etc.) -- the easy miss -- and every column value,
// looking for the raw bytes of `needle`. This is the sanctioned way to
// assert "this secret is nowhere in the database", stronger than checking
// individual columns one by one because it also catches a leak into the
// FTS index's term dictionary, which an ordinary `SELECT text FROM
// memories_fts` would not: that query reads through to the (already
// redacted) memories.text column rather than the index's own storage.
function dbContainsRawBytes(db: CairnDb, needle: string): boolean {
  const needleBytes = Buffer.from(needle, "utf8");
  const tables = db
    .q(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all();
  for (const t of tables) {
    const name = String(t["name"]);
    let rows;
    try {
      rows = db.q(`SELECT * FROM ${name}`).all();
    } catch {
      continue;
    }
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value === "string" && value.includes(needle)) return true;
        if (value instanceof Uint8Array) {
          const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          if (buf.includes(needleBytes)) return true;
        }
      }
    }
  }
  return false;
}

test("remember in 'on' mode redacts secrets in the memory, the episode, and the FTS index", () => {
  withStore((store) => {
    setPrivacyMode(store.db, "on");
    const content = `AWS key: ${AWS_KEY} and GitHub token: ${GH_TOKEN}`;

    const { memory, episodeId, redactions } = store.remember({ content });

    assert.equal(memory.redacted, true);
    assert.match(memory.text, /\[redacted:aws-access-key-id\]/);
    assert.match(memory.text, /\[redacted:github-token\]/);
    assert.ok(!memory.text.includes(AWS_KEY));
    assert.ok(!memory.text.includes(GH_TOKEN));

    const episode = store.episode(episodeId);
    assert.ok(episode);
    assert.ok(!episode.content.includes(AWS_KEY));
    assert.ok(!episode.content.includes(GH_TOKEN));

    assert.equal(dbContainsRawBytes(store.db, AWS_KEY), false);
    assert.equal(dbContainsRawBytes(store.db, GH_TOKEN), false);

    const redactionRows = store.db.q(`SELECT * FROM redactions`).all();
    assert.equal(redactionRows.length, 2);
    for (const row of redactionRows) {
      assert.equal(row["action"], "redacted");
      assert.equal(row["memory_id"], memory.id);
    }

    assert.deepEqual(
      redactions.map((r) => r.kind).sort(),
      ["aws-access-key-id", "github-token"],
    );
    assert.ok(redactions.every((r) => r.count === 1));
  });
});

test("remember in 'strict' mode blocks the write entirely and records blocked redactions", () => {
  withStore((store) => {
    setPrivacyMode(store.db, "strict");
    const content = `AWS key: ${AWS_KEY} and GitHub token: ${GH_TOKEN}`;

    let thrown: Error | undefined;
    try {
      store.remember({ content });
    } catch (error) {
      thrown = error as Error;
    }
    assert.ok(thrown, "expected strict mode to throw");
    assert.match(thrown.message, /aws-access-key-id/);
    assert.match(thrown.message, /github-token/);
    assert.ok(!thrown.message.includes(AWS_KEY));
    assert.ok(!thrown.message.includes(GH_TOKEN));

    assert.equal(countRows(store, "memories"), 0);
    assert.equal(countRows(store, "episodes"), 0);

    const redactionRows = store.db.q(`SELECT * FROM redactions`).all();
    assert.equal(redactionRows.length, 2);
    for (const row of redactionRows) {
      assert.equal(row["action"], "blocked");
      assert.equal(row["memory_id"], null);
    }
  });
});

test("remember in 'off' mode stores content verbatim and records nothing", () => {
  withStore((store) => {
    setPrivacyMode(store.db, "off");
    const content = `AWS key: ${AWS_KEY}`;

    const { memory, redactions } = store.remember({ content });

    assert.equal(memory.text, content);
    assert.equal(memory.redacted, false);
    assert.deepEqual(redactions, []);
    assert.equal(countRows(store, "redactions"), 0);
  });
});

test("a recall query containing a secret is stored redacted in the access log", async () => {
  await withStoreAsync(async (store) => {
    setPrivacyMode(store.db, "on");
    const query = `looking for ${AWS_KEY}`;

    await store.recall(query);

    const { items } = store.auditLog({ action: "recall" });
    const entry = items.find((e) => e.query !== null);
    assert.ok(entry);
    assert.ok(!(entry.query ?? "").includes(AWS_KEY));
    assert.match(entry.query ?? "", /\[redacted:aws-access-key-id\]/);
  });
});

test("deleteEverything hard-deletes memories/episodes/tags/FTS/vectors across two vector spaces, leaving audit/settings/clients/redactions intact", () => {
  withStore((store) => {
    assert.equal(store.capabilities.vectors, true, "sqlite-vec must load for this test to be meaningful");

    setPrivacyMode(store.db, "on");
    const { memory } = store.remember({ content: `secret ${AWS_KEY}` }, { sourceClient: "purger" });

    const spaceA = ensureVectorSpace(store.db, "test-model-a", 4);
    const spaceB = ensureVectorSpace(store.db, "test-model-b", 4);
    upsertVector(store.db, spaceA, memory.seq, new Float32Array([1, 0, 0, 0]), {
      scope: memory.scope,
      live: true,
      createdAt: Date.now(),
    });
    upsertVector(store.db, spaceB, memory.seq, new Float32Array([0, 1, 0, 0]), {
      scope: memory.scope,
      live: true,
      createdAt: Date.now(),
    });

    const auditRowsBefore = store.db.q(`SELECT id FROM audit_log`).all();
    const clientsBefore = countRows(store, "clients");
    const settingsBefore = countRows(store, "settings");
    const redactionsBefore = countRows(store, "redactions");
    assert.ok(redactionsBefore > 0);

    const result = store.deleteEverything({ confirm: true });

    assert.equal(result.memories, 1);
    assert.equal(result.episodes, 1);
    assert.equal(result.vectors, 2);

    assert.equal(countRows(store, "memories"), 0);
    assert.equal(countRows(store, "episodes"), 0);
    assert.equal(countRows(store, "memory_tags"), 0);
    assert.equal(store.db.q(`SELECT COUNT(*) AS c FROM memories_fts`).get()?.["c"], 0);
    assert.equal(store.db.q(`SELECT COUNT(*) AS c FROM ${spaceA.tableName}`).get()?.["c"], 0);
    assert.equal(store.db.q(`SELECT COUNT(*) AS c FROM ${spaceB.tableName}`).get()?.["c"], 0);

    // audit_log, settings, clients, redactions all survive the purge --
    // every pre-purge row is still there (plus the purge's own audit row).
    const auditRowIdsAfter = new Set(store.db.q(`SELECT id FROM audit_log`).all().map((r) => r["id"]));
    for (const row of auditRowsBefore) {
      assert.ok(auditRowIdsAfter.has(row["id"]));
    }
    assert.equal(countRows(store, "clients"), clientsBefore);
    assert.equal(countRows(store, "settings"), settingsBefore);
    assert.equal(countRows(store, "redactions"), redactionsBefore);
  });
});

test("deleteEverything refuses without confirm: true", () => {
  withStore((store) => {
    store.remember({ content: "kept" });
    assert.throws(() => store.deleteEverything({ confirm: false as unknown as true }), /confirm/);
    assert.equal(countRows(store, "memories"), 1);
  });
});
