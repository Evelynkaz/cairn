import { test } from "node:test";
import assert from "node:assert/strict";
import { getLoadablePath } from "sqlite-vec";
import { openNodeSqlite } from "./node-sqlite.js";
import { withTempDir, tempDbPath } from "../../testing/tmp.js";

test("integer-valued numbers reach SQLite with INTEGER storage class", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  db.exec("create table t(x)");
  db.prepare("insert into t(x) values (?)").run(1);
  const row = db.prepare("select typeof(x) as t from t").get();
  assert.equal(row?.t, "integer");
  db.close();
});

test("non-integer numbers stay REAL", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  db.exec("create table t(x)");
  db.prepare("insert into t(x) values (?)").run(0.5);
  const row = db.prepare("select typeof(x) as t, x from t").get();
  assert.equal(row?.t, "real");
  assert.equal(row?.x, 0.5);
  db.close();
});

test("large safe integers round-trip exactly", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  db.exec("create table t(x)");
  const value = 1700000000000;
  db.prepare("insert into t(x) values (?)").run(value);
  const row = db.prepare("select x from t").get();
  assert.equal(row?.x, value);
  db.close();
});

test("rows returned by get, all, and iterate are plain objects", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  db.exec("create table t(x)");
  db.prepare("insert into t(x) values (?)").run(1);

  const gotten = db.prepare("select x from t").get();
  assert.equal(Object.getPrototypeOf(gotten), Object.prototype);

  const all = db.prepare("select x from t").all();
  assert.equal(Object.getPrototypeOf(all[0]), Object.prototype);

  const iterated = [...db.prepare("select x from t").iterate()];
  assert.equal(Object.getPrototypeOf(iterated[0]), Object.prototype);

  db.close();
});

test("undefined parameter throws an error naming the index", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  db.exec("create table t(x, y)");
  assert.throws(
    () => db.prepare("insert into t(x, y) values (?, ?)").run(1, undefined as unknown as null),
    /parameter 1 is undefined/,
  );
  db.close();
});

test("null and Uint8Array blobs round-trip correctly", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  db.exec("create table t(x, y)");
  const blob = new Uint8Array([1, 2, 3, 4]);
  db.prepare("insert into t(x, y) values (?, ?)").run(null, blob);
  const row = db.prepare("select x, y from t").get();
  assert.equal(row?.x, null);
  assert.deepEqual(row?.y, blob);
  db.close();
});

test("run() returns numeric changes and lastInsertRowid", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  db.exec("create table t(x integer primary key, y)");
  const result = db.prepare("insert into t(y) values (?)").run("a");
  assert.equal(typeof result.changes, "number");
  assert.equal(typeof result.lastInsertRowid, "number");
  assert.equal(result.changes, 1);
  assert.equal(result.lastInsertRowid, 1);
  db.close();
});

test("close() is idempotent and using the driver after close throws", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  db.exec("create table t(x)");
  db.close();
  assert.doesNotThrow(() => db.close());
  assert.throws(() => db.exec("create table u(x)"));
});

test("readOnly driver rejects a write against a preexisting file database", () => {
  withTempDir((dir) => {
    const path = tempDbPath(dir);
    const writer = openNodeSqlite({ path });
    writer.exec("create table t(x)");
    writer.exec("insert into t(x) values (1), (2), (3)");
    writer.close();

    const reader = openNodeSqlite({ path, readOnly: true });
    assert.throws(() => reader.exec("insert into t(x) values (1)"), /readonly/);

    const row = reader.prepare("select count(*) as c from t").get();
    assert.equal(row?.c, 3);

    reader.close();
  });
});

test("allowExtension: false makes loadExtension throw before touching the database", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  assert.throws(() => db.loadExtension("does-not-matter"), /extension loading is disabled/);
  db.close();
});

test("loadExtension loads sqlite-vec and disables extension loading afterwards", (t) => {
  let extPath: string;
  try {
    extPath = getLoadablePath();
  } catch {
    t.skip("sqlite-vec has no loadable extension on this platform");
    return;
  }

  const db = openNodeSqlite({ path: ":memory:", allowExtension: true });
  db.loadExtension(extPath);
  const row = db.prepare("select vec_version() as v").get();
  assert.equal(typeof row?.v, "string");
  assert.ok((row?.v as string).length > 0);

  // Extension loading was disabled again after the first call.
  assert.throws(
    () => db.prepare("select load_extension(?) as r").get(extPath),
    /not authorized/,
  );

  // A second explicit call must re-enable it and succeed rather than
  // staying armed or broken.
  assert.doesNotThrow(() => db.loadExtension(extPath));

  db.close();
});

test("iterate yields rows in insertion order", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  db.exec("create table t(x)");
  const insert = db.prepare("insert into t(x) values (?)");
  insert.run(1);
  insert.run(2);
  insert.run(3);

  const iterator = db.prepare("select x from t order by x").iterate();
  const first = iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.x, 1);

  const rest = [...iterator].map((r) => r.x);
  assert.deepEqual(rest, [2, 3]);

  db.close();
});

test("iterate is lazy: a query all() could never finish yields incrementally", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  const it = db
    .prepare("with recursive c(n) as (select 1 union all select n+1 from c) select n from c")
    .iterate();
  assert.equal(it.next().value?.["n"], 1);
  it.return?.(undefined);
  db.close();
});

test("NaN parameter throws an error naming the index", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  db.exec("create table t(x)");
  assert.throws(
    () => db.prepare("insert into t(x) values (?)").run(NaN),
    /parameter 0 is NaN/,
  );
  db.close();
});

test("Infinity parameter throws an error naming the index", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  db.exec("create table t(x, y)");
  assert.throws(
    () => db.prepare("insert into t(x, y) values (?, ?)").run(1, Infinity),
    /parameter 1 is Infinity/,
  );
  assert.throws(
    () => db.prepare("insert into t(x, y) values (?, ?)").run(1, -Infinity),
    /parameter 1 is -Infinity/,
  );
  db.close();
});

test("iterate validates parameter count at call time, not on first next()", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  db.exec("create table t(x, y)");
  assert.throws(
    () => db.prepare("insert into t(x, y) values (?, ?)").iterate(undefined as unknown as null, 1),
    /parameter 0 is undefined/,
  );
  db.close();
});

test("an abandoned iterator does not poison the statement: a new iterate() starts over", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  db.exec("create table t(x)");
  const insert = db.prepare("insert into t(x) values (?)");
  insert.run(1);
  insert.run(2);
  insert.run(3);

  const stmt = db.prepare("select x from t order by x");
  const abandoned = stmt.iterate();
  abandoned.next(); // dropped here: no for-of, no return(), no exhaustion

  assert.doesNotThrow(() => stmt.iterate());
  const restarted = [...stmt.iterate()].map((r) => r.x);
  assert.deepEqual(restarted, [1, 2, 3]);

  db.close();
});

test("after an abandoned iterator is auto-finalized by a new iterate(), get/all/run work again", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  db.exec("create table t(x)");

  const stmt = db.prepare("insert into t(x) values (?) returning x");
  const abandoned = stmt.iterate(1);
  abandoned.next();

  const restarted = [...stmt.iterate(2)].map((r) => r.x);
  assert.deepEqual(restarted, [2]);

  assert.doesNotThrow(() => stmt.run(3));
  assert.doesNotThrow(() => stmt.get(4));
  assert.doesNotThrow(() => stmt.all(5));

  db.close();
});

test("two iterate() calls in sequence on the same statement each yield the complete result set", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  db.exec("create table t(x)");
  const insert = db.prepare("insert into t(x) values (?)");
  insert.run(1);
  insert.run(2);
  insert.run(3);

  const stmt = db.prepare("select x from t order by x");
  const firstRun = [...stmt.iterate()].map((r) => r.x);
  const secondRun = [...stmt.iterate()].map((r) => r.x);

  assert.deepEqual(firstRun, [1, 2, 3]);
  assert.deepEqual(secondRun, [1, 2, 3]);

  db.close();
});

test("calling all() on a statement whose own iterator is live throws", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  db.exec("create table t(x)");
  db.prepare("insert into t(x) values (?)").run(1);

  const stmt = db.prepare("select x from t");
  const iterator = stmt.iterate();
  iterator.next();
  assert.throws(() => stmt.all(), /statement is already iterating/);

  db.close();
});

test("an early break out of an iterate loop releases the guard", () => {
  const db = openNodeSqlite({ path: ":memory:" });
  db.exec("create table t(x)");
  const insert = db.prepare("insert into t(x) values (?)");
  insert.run(1);
  insert.run(2);

  const stmt = db.prepare("select x from t order by x");
  for (const _row of stmt.iterate()) {
    break;
  }

  assert.doesNotThrow(() => stmt.all());
  db.close();
});
