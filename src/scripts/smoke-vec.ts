// Standalone CI smoke test (no test framework): proves the sqlite-vec
// loadable extension actually loads and a vec0 KNN query actually works on
// this platform. Run per-OS in CI so a broken prebuilt binary shows up as
// its own red step rather than being buried inside `npm test` output.

import { withTempDir, tempDbPath } from "../testing/tmp.js";
import { openDb } from "../storage/db.js";

function f32(values: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(values).buffer);
}

function main(): void {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      if (!db.capabilities.vectors) {
        throw new Error(
          `sqlite-vec did not load: ${db.capabilities.vectorError ?? "unknown error"}`,
        );
      }
      const versionRow = db.q("select vec_version() as v").get();
      const version = versionRow?.["v"];
      if (typeof version !== "string" || version.length === 0) {
        throw new Error("vec_version() did not return a version string");
      }
      console.log(`vec_version: ${version}`);

      db.exec(
        "CREATE VIRTUAL TABLE smoke_vec USING vec0(embedding float[4], scope text)",
      );

      const insert = db.q(
        "INSERT INTO smoke_vec (rowid, embedding, scope) VALUES (?, ?, ?)",
      );
      insert.run(1, f32([1, 0, 0, 0]), "default");
      insert.run(2, f32([0, 1, 0, 0]), "default");
      insert.run(3, f32([0.99, 0.01, 0, 0]), "default");

      const results = db
        .q(
          `SELECT rowid, distance FROM smoke_vec
           WHERE embedding MATCH ? AND scope = ? AND k = 1
           ORDER BY distance`,
        )
        .all(f32([0.9, 0.1, 0, 0]), "default");

      if (results.length !== 1 || results[0]?.["rowid"] !== 3) {
        throw new Error(
          `expected nearest row to be rowid 3, got: ${JSON.stringify(results)}`,
        );
      }

      console.log(
        `sqlite-vec smoke test passed on ${process.platform}/${process.arch}`,
      );
    } finally {
      db.close();
    }
  });
}

try {
  main();
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
