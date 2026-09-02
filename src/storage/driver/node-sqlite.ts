import { DatabaseSync } from "node:sqlite";
import type {
  DriverFactory,
  PreparedStatement,
  Row,
  RunResult,
  SqlValue,
} from "./types.js";

// Both node:sqlite and better-sqlite3 bind a plain integer-valued JS
// `number` with SQLite storage class REAL (verified: `run(1)` then
// `typeof(x)` returns 'real' on both bindings, while `run(1n)` returns
// 'integer'). Ordinary tables hide this behind column affinity, but virtual
// tables do not, and sqlite-vec's vec0 rejects such a value outright with
// "Only integers are allows for primary key values". So every safe-integer
// number is bound as a BigInt instead — this is part of the seam contract
// (types.ts rule 2), not a node:sqlite-only workaround.
function normalizeParam(v: SqlValue, index: number): SqlValue | bigint {
  if (v === undefined) {
    throw new Error(`parameter ${index} is undefined; pass null explicitly`);
  }
  if (typeof v === "number" && !Number.isFinite(v)) {
    throw new Error(`parameter ${index} is ${v}; SQLite cannot store NaN or Infinity`);
  }
  if (typeof v === "number" && Number.isSafeInteger(v)) {
    return BigInt(v);
  }
  return v;
}

function normalizeParams(params: SqlValue[]): (SqlValue | bigint)[] {
  return params.map((v, i) => normalizeParam(v, i));
}

function normalizeRow(row: Record<string, SqlValue>): Row {
  return { ...row };
}

export const openNodeSqlite: DriverFactory = (options) => {
  const allowExtension = options.allowExtension ?? false;
  const db = new DatabaseSync(options.path, {
    allowExtension,
    readOnly: options.readOnly ?? false,
  });

  return {
    name: "node-sqlite",

    get isOpen(): boolean {
      return db.isOpen;
    },

    prepare(sql: string): PreparedStatement {
      const stmt = db.prepare(sql);
      let active = false;
      // The generator currently driving `stmt`'s cursor, if any. A consumer
      // that calls `.next()` once and then drops the iterator (no for-of,
      // no spread, no explicit `.return()`) never runs the generator's
      // `finally`, so without this reference `active` would stay true
      // forever and every later get/all/run/iterate on this statement
      // would throw for the life of the connection.
      let liveIterator: Generator<Row, void, undefined> | undefined;

      const guard = (): void => {
        if (active) {
          throw new Error("statement is already iterating; prepare a second statement");
        }
      };

      return {
        get(...params: SqlValue[]): Row | undefined {
          guard();
          const row = stmt.get(...normalizeParams(params));
          return row === undefined ? undefined : normalizeRow(row);
        },
        all(...params: SqlValue[]): Row[] {
          guard();
          return stmt.all(...normalizeParams(params)).map(normalizeRow);
        },
        run(...params: SqlValue[]): RunResult {
          guard();
          const result = stmt.run(...normalizeParams(params));
          return {
            changes: Number(result.changes),
            lastInsertRowid: Number(result.lastInsertRowid),
          };
        },
        iterate(...params: SqlValue[]): IterableIterator<Row> {
          // A new iterate() call is unambiguously "start over": finalize
          // any generator left over from a previous iterate() (types.ts
          // rule 7) rather than throw, so an abandoned iterator cannot
          // permanently poison this statement. Calling `.return()` runs
          // the old generator's `finally`, clearing `active` and releasing
          // the cursor; the underlying SQLite statement would be reset by
          // this new binding anyway.
          if (active && liveIterator) {
            liveIterator.return(undefined);
          }
          const normalized = normalizeParams(params);
          const generator = (function* (): Generator<Row, void, undefined> {
            active = true;
            try {
              for (const row of stmt.iterate(...normalized)) {
                yield normalizeRow(row);
              }
            } finally {
              active = false;
              liveIterator = undefined;
            }
          })();
          liveIterator = generator;
          return generator;
        },
      };
    },

    exec(sql: string): void {
      db.exec(sql);
    },

    loadExtension(path: string): void {
      if (!allowExtension) {
        throw new Error("extension loading is disabled; open the driver with allowExtension: true");
      }
      db.enableLoadExtension(true);
      try {
        db.loadExtension(path);
      } finally {
        db.enableLoadExtension(false);
      }
    },

    close(): void {
      if (db.isOpen) {
        db.close();
      }
    },
  };
};
