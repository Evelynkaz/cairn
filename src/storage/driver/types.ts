// This module is the seam between Cairn's storage layer and the concrete
// SQLite binding. Every implementation of SqliteDriver must uphold the
// contract rules below, because they are what makes the swap (node:sqlite ->
// better-sqlite3) real rather than theoretical:
//
// 1. POSITIONAL PARAMETERS ONLY (`?`). Named-parameter prefixes differ
//    between bindings, so named parameters are outside this contract.
// 2. Integer-valued numbers MUST reach SQLite with INTEGER storage class,
//    not REAL. Both node:sqlite and better-sqlite3 bind a plain
//    integer-valued JS `number` as REAL (verified against better-sqlite3
//    13.0.3: `run(1)` stores a value whose `typeof(x)` is 'real'; only a
//    bound BigInt, e.g. `run(1n)`, stores INTEGER). Ordinary tables hide
//    this behind column affinity, but virtual tables do not — sqlite-vec's
//    vec0 rejects a REAL primary key outright with "Only integers are
//    allows for primary key values". So this normalization (safe-integer
//    number -> BigInt) is part of the seam contract itself, not a
//    node:sqlite workaround, and every implementation must perform it.
//    Consequence: because bound integers arrive as INTEGER, SQLite integer
//    arithmetic applies to them — `select ?/2` bound with 5 yields 2, not
//    2.5. Any SQL that does arithmetic on a bound parameter and wants a
//    real result must cast explicitly (e.g. `select ? / 2.0`).
// 3. Rows MUST be plain objects with `Object.prototype` — node:sqlite
//    returns null-prototype objects, and callers must not have to care.
// 4. ITERATOR EXCLUSIVITY has two distinct levels, and they are not the
//    same rule:
//    - STATEMENT-level aliasing: one statement's cursor must not be
//      re-bound (get/all/run/iterate) while that same statement's own
//      iterator is live. This is enforced by this driver (see rule 7) and
//      throws.
//    - CONNECTION-level exclusivity: some bindings — notably
//      better-sqlite3 — additionally forbid ANY other operation on the
//      whole connection (a different statement's get/all/run, or even
//      `close()`) while any iterator anywhere on that connection is
//      unfinished; it throws "This database connection is busy executing
//      a query". The node:sqlite driver does NOT enforce this and cannot
//      detect it here — a violation is silently permitted.
//    Portable calling code must respect the connection-level rule (never
//    write, or touch any other statement, inside an unfinished `iterate`
//    loop) even though this driver permits violating it. Any test or
//    repository that relies on node:sqlite's laxity here — e.g. driving a
//    second statement inside a live `iterate()` loop on the connection —
//    is driver-specific and must be marked as such; it will throw after a
//    swap to better-sqlite3. The db layer's strategy of preparing a fresh
//    statement per `iterate()` call removes statement-level aliasing only;
//    it does not make connection-level violations portable.
// 5. EXACT ARGUMENT COUNT: the number of arguments passed to
//    get/all/run/iterate must match the number of `?` placeholders exactly.
//    node:sqlite silently binds a missing placeholder as NULL (a
//    `WHERE x = ?` call with no argument returns nothing, no error);
//    better-sqlite3 throws "Too few parameter values were provided". Callers
//    must not rely on the silent-NULL behavior.
// 6. EXTENSION GATE: `allowExtension: false` MUST cause `loadExtension()` to
//    throw, whether or not the underlying binding enforces it itself.
//    better-sqlite3 has no such option and loads extensions
//    unconditionally, so a driver that merely forwards the flag would let a
//    deliberate safety gate silently evaporate on swap.
// 7. STATEMENT SINGLE USE: a `PreparedStatement` has exactly one cursor and
//    must not be driven concurrently — do not start a second get/all/run
//    on the same statement while an `iterate()` from it is still live. On
//    node:sqlite this silently corrupts results instead of erroring
//    (interleaved iterators skip and duplicate rows; calling `.all()`
//    while an iterator is live resets the shared cursor). better-sqlite3
//    throws loudly for both, so every implementation must throw here too
//    rather than let the swap turn silent corruption into a loud (but
//    previously untested) failure. A second `iterate()` call on the same
//    statement is the one exception: starting a new iteration is
//    unambiguously "start over", so every implementation must finalize the
//    still-live iterator first (as if its consumer had called `.return()`)
//    and then proceed, rather than throw — this is what makes an abandoned
//    iterator (a consumer that calls `next()` once and drops the iterator
//    without exhausting or closing it) recoverable instead of a permanent
//    poison on the statement.
//
// Booleans are deliberately absent from `SqlValue`: SQLite has no boolean
// type, so callers pass 0/1 explicitly.

export type SqlValue = string | number | bigint | Uint8Array | null;
export type Row = Record<string, SqlValue>;
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface PreparedStatement {
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
  run(...params: SqlValue[]): RunResult;
  iterate(...params: SqlValue[]): IterableIterator<Row>;
}

export interface SqliteDriver {
  readonly name: string;
  readonly isOpen: boolean;
  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
  loadExtension(path: string): void;
  close(): void;
}

export interface OpenOptions {
  path: string;
  allowExtension?: boolean;
  readOnly?: boolean;
}
export type DriverFactory = (options: OpenOptions) => SqliteDriver;
