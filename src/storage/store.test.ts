import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempDir, tempDbPath } from "../testing/tmp.js";
import { openStore } from "./store.js";
import type { CallContext, Store } from "./store.js";

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
  update: (store, id, ctx) => store.update(id, { text: "gate probe" }, ctx),
  forget: (store, id, ctx) => store.forget(id, ctx),
  restore: (store, id, ctx) => store.restore(id, ctx),
  supersede: (store, id, ctx) => store.supersede(id, { text: "gate probe" }, ctx),
  asOf: (store, _id, ctx) => store.asOf(Date.now(), {}, ctx),
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
]);

test("the gated-method table matches the store's actual surface exactly", () => {
  withStore((store) => {
    const actual = new Set(Object.keys(store));
    const expected = new Set([...Object.keys(GATED_METHODS), ...DELIBERATELY_UNGATED]);
    assert.deepEqual([...actual].sort(), [...expected].sort());
  });
});

test("every gated method refuses a disabled client and records the refusal in the audit log", () => {
  for (const [name, invoke] of Object.entries(GATED_METHODS)) {
    withStore((store) => {
      const clientId = `paused-${name}`;
      // Register the client first via a harmless read.
      store.list({}, { sourceClient: clientId });
      store.setClientEnabled(clientId, false);

      const before = store.clientStats().find((s) => s.sourceClient === clientId);
      assert.throws(
        () => invoke(store, "does-not-exist", { sourceClient: clientId }),
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

test("close() is idempotent", () => {
  withTempDir((dir) => {
    const store = openStore({ path: tempDbPath(dir) });
    store.close();
    assert.doesNotThrow(() => store.close());
  });
});
