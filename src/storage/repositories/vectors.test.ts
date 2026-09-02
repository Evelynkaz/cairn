import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempDir, tempDbPath } from "../../testing/tmp.js";
import { openDb } from "../db.js";
import {
  ensureVectorSpace,
  getVectorSpace,
  listVectorSpaces,
  upsertVector,
  setVectorLive,
  deleteVector,
  knn,
  getVectorsBySeq,
  memorySeqsMissingVectors,
  countMemoriesMissingVectors,
} from "./vectors.js";
import type { VectorSpaceRef } from "./vectors.js";

function vec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

// Inserted with direct SQL rather than the memories repository, which is
// being edited concurrently by another builder.
function insertMemoryRow(
  db: ReturnType<typeof openDb>,
  fields: {
    id: string;
    scope?: string;
    contentHash?: string;
    validUntil?: number | null;
    deletedAt?: number | null;
  },
): number {
  const now = Date.now();
  const result = db
    .q(
      `INSERT INTO memories
         (id, text, scope, created_at, updated_at, valid_from, valid_until, deleted_at, content_hash, importance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fields.id,
      "some text",
      fields.scope ?? "default",
      now,
      now,
      now,
      fields.validUntil ?? null,
      fields.deletedAt ?? null,
      fields.contentHash ?? `hash-${fields.id}`,
      0.5,
    );
  return result.lastInsertRowid;
}

test("ensureVectorSpace creates the table and registry row; calling twice returns the identical ref and creates nothing new", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      assert.equal(db.capabilities.vectors, true, "sqlite-vec must load for this suite to be meaningful");
      const first = ensureVectorSpace(db, "test-model", 4);
      const second = ensureVectorSpace(db, "test-model", 4);
      assert.deepEqual(first, second);

      const registryRows = db.q("select count(*) as c from vector_spaces").get();
      assert.equal(registryRows?.["c"], 1);

      const tableExists = db
        .q("select name from sqlite_master where name = ?")
        .get(first.tableName);
      assert.ok(tableExists);
    } finally {
      db.close();
    }
  });
});

test("two different (modelId, dim) pairs produce two separate tables, and KNN never crosses them", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const spaceA = ensureVectorSpace(db, "model-a", 3);
      const spaceB = ensureVectorSpace(db, "model-b", 3);
      assert.notEqual(spaceA.tableName, spaceB.tableName);

      upsertVector(db, spaceA, 1, vec(1, 0, 0), { scope: "default", live: true, createdAt: Date.now() });

      const hitsInA = knn(db, spaceA, vec(1, 0, 0), { k: 10 });
      assert.equal(hitsInA.length, 1);
      assert.equal(hitsInA[0]?.memorySeq, 1);

      // Requirement: this must fail if isolation is broken (e.g. both
      // spaces accidentally pointed at the same table).
      const hitsInB = knn(db, spaceB, vec(1, 0, 0), { k: 10 });
      assert.equal(hitsInB.length, 0);
    } finally {
      db.close();
    }
  });
});

test("a model id with punctuation/uppercase sanitizes to a valid table name and is retrievable by the original model id", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const space = ensureVectorSpace(db, "BAAI/bge-small-en-v1.5", 384);
      assert.match(space.tableName, /^vec_[a-z0-9_]+_\d+_[0-9a-f]{8}$/);

      const fetched = getVectorSpace(db, "BAAI/bge-small-en-v1.5", 384);
      assert.deepEqual(fetched, space);

      const spaces = listVectorSpaces(db);
      assert.equal(spaces.length, 1);
      assert.equal(spaces[0]?.modelId, "BAAI/bge-small-en-v1.5");
    } finally {
      db.close();
    }
  });
});

test("a table name that would sanitize to empty throws", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      assert.throws(() => ensureVectorSpace(db, "---", 4), /sanitizes to an empty table name/);
    } finally {
      db.close();
    }
  });
});

test("an embedding of the wrong length throws before any write", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const space = ensureVectorSpace(db, "wrong-length-model", 4);
      assert.throws(
        () => upsertVector(db, space, 1, vec(1, 2, 3), { scope: "default", live: true, createdAt: Date.now() }),
        /expects dim 4/,
      );
      const count = db.q(`select count(*) as c from ${space.tableName}`).get();
      assert.equal(count?.["c"], 0);
    } finally {
      db.close();
    }
  });
});

test("upsertVector twice for the same memorySeq leaves exactly one row and the second embedding wins", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const space = ensureVectorSpace(db, "upsert-model", 3);
      const now = Date.now();
      upsertVector(db, space, 1, vec(1, 0, 0), { scope: "default", live: true, createdAt: now });
      upsertVector(db, space, 1, vec(0, 1, 0), { scope: "default", live: true, createdAt: now });

      const count = db.q(`select count(*) as c from ${space.tableName}`).get();
      assert.equal(count?.["c"], 1);

      const hits = knn(db, space, vec(0, 1, 0), { k: 1 });
      assert.equal(hits.length, 1);
      assert.equal(hits[0]?.memorySeq, 1);
      assert.ok((hits[0]?.distance ?? 1) < 0.001);
    } finally {
      db.close();
    }
  });
});

test("knn respects scope and live filters; setVectorLive toggles visibility without deleting the row", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const space = ensureVectorSpace(db, "filter-model", 2);
      const now = Date.now();
      upsertVector(db, space, 1, vec(1, 0), { scope: "scope-a", live: true, createdAt: now });
      upsertVector(db, space, 2, vec(1, 0), { scope: "scope-b", live: true, createdAt: now });

      const onlyA = knn(db, space, vec(1, 0), { k: 10, scope: "scope-a" });
      assert.deepEqual(onlyA.map((h) => h.memorySeq).sort(), [1]);

      setVectorLive(db, space, 1, false);
      const liveOnly = knn(db, space, vec(1, 0), { k: 10, live: true });
      assert.deepEqual(liveOnly.map((h) => h.memorySeq).sort(), [2]);

      const rowStillExists = db.q(`select count(*) as c from ${space.tableName} where memory_seq = ?`).get(1);
      assert.equal(rowStillExists?.["c"], 1);

      setVectorLive(db, space, 1, true);
      const liveAgain = knn(db, space, vec(1, 0), { k: 10, live: true });
      assert.deepEqual(liveAgain.map((h) => h.memorySeq).sort(), [1, 2]);

      deleteVector(db, space, 2);
      const afterDelete = db.q(`select count(*) as c from ${space.tableName} where memory_seq = ?`).get(2);
      assert.equal(afterDelete?.["c"], 0);
    } finally {
      db.close();
    }
  });
});

test("k clamps at 200 and defaults to 10", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const space = ensureVectorSpace(db, "k-clamp-model", 8);
      const now = Date.now();
      db.tx(() => {
        for (let i = 1; i <= 250; i++) {
          const values = Array.from({ length: 8 }, (_, j) => ((i + j) % 7) + 1);
          upsertVector(db, space, i, vec(...values), { scope: "default", live: true, createdAt: now });
        }
      });

      const query = vec(1, 2, 3, 4, 5, 6, 7, 1);
      const defaulted = knn(db, space, query, {});
      assert.equal(defaulted.length, 10);

      const uncapped = knn(db, space, query, { k: 1000 });
      assert.equal(uncapped.length, 200);
    } finally {
      db.close();
    }
  });
});

test("cosine distance: an identical vector has distance ~0 and an orthogonal one ~1", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const space = ensureVectorSpace(db, "cosine-model", 4);
      const now = Date.now();
      upsertVector(db, space, 1, vec(1, 0, 0, 0), { scope: "default", live: true, createdAt: now });
      upsertVector(db, space, 2, vec(0, 1, 0, 0), { scope: "default", live: true, createdAt: now });

      const hits = knn(db, space, vec(1, 0, 0, 0), { k: 10 });
      const identical = hits.find((h) => h.memorySeq === 1);
      const orthogonal = hits.find((h) => h.memorySeq === 2);
      assert.ok(identical);
      assert.ok(orthogonal);
      assert.ok(Math.abs(identical.distance - 0) < 0.01);
      assert.ok(Math.abs(orthogonal.distance - 1) < 0.01);
    } finally {
      db.close();
    }
  });
});

test("getVectorsBySeq returns stored vectors keyed by seq, and omits seqs with no row", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const space = ensureVectorSpace(db, "get-by-seq-model", 3);
      const now = Date.now();
      upsertVector(db, space, 1, vec(1, 0, 0), { scope: "default", live: true, createdAt: now });
      upsertVector(db, space, 2, vec(0, 1, 0), { scope: "default", live: true, createdAt: now });

      const result = getVectorsBySeq(db, space, [1, 2, 999]);
      assert.equal(result.size, 2);
      assert.deepEqual(Array.from(result.get(1) ?? []), [1, 0, 0]);
      assert.deepEqual(Array.from(result.get(2) ?? []), [0, 1, 0]);
      assert.equal(result.has(999), false);
    } finally {
      db.close();
    }
  });
});

test("getVectorsBySeq returns an empty map for an empty seq list without querying", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const space = ensureVectorSpace(db, "get-by-seq-empty-model", 2);
      assert.deepEqual(getVectorsBySeq(db, space, []), new Map());
    } finally {
      db.close();
    }
  });
});

test("getVectorsBySeq rejects a hand-built VectorSpaceRef with a malformed table name", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const maliciousSpace: VectorSpaceRef = {
        id: 1,
        modelId: "evil",
        dim: 3,
        tableName: "evil; DROP TABLE memories;--",
      };
      assert.throws(() => getVectorsBySeq(db, maliciousSpace, [1]), /vector table name .* is invalid/);
    } finally {
      db.close();
    }
  });
});

test("getVectorsBySeq throws once the requested seq count exceeds its cap", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const space = ensureVectorSpace(db, "get-by-seq-cap-model", 2);
      const tooMany = Array.from({ length: 1001 }, (_, i) => i + 1);
      assert.throws(() => getVectorsBySeq(db, space, tooMany), /exceeds the .* cap/);
    } finally {
      db.close();
    }
  });
});

test("with CAIRN_NO_VECTORS=1, getVectorsBySeq throws mentioning the disabled reason", () => {
  const previous = process.env["CAIRN_NO_VECTORS"];
  process.env["CAIRN_NO_VECTORS"] = "1";
  try {
    withTempDir((dir) => {
      const db = openDb({ path: tempDbPath(dir) });
      try {
        const fakeSpace: VectorSpaceRef = { id: 1, modelId: "fake", dim: 4, tableName: "vec_fake_4" };
        assert.throws(() => getVectorsBySeq(db, fakeSpace, [1]), /CAIRN_NO_VECTORS/);
      } finally {
        db.close();
      }
    });
  } finally {
    if (previous === undefined) {
      delete process.env["CAIRN_NO_VECTORS"];
    } else {
      process.env["CAIRN_NO_VECTORS"] = previous;
    }
  }
});

test("with CAIRN_NO_VECTORS=1, every exported function throws mentioning the disabled reason, and openDb still succeeds", () => {
  const previous = process.env["CAIRN_NO_VECTORS"];
  process.env["CAIRN_NO_VECTORS"] = "1";
  try {
    withTempDir((dir) => {
      const db = openDb({ path: tempDbPath(dir) });
      try {
        assert.equal(db.capabilities.vectors, false);
        const fakeSpace: VectorSpaceRef = { id: 1, modelId: "fake", dim: 4, tableName: "vec_fake_4" };
        const embedding = vec(1, 2, 3, 4);

        assert.throws(() => ensureVectorSpace(db, "fake", 4), /CAIRN_NO_VECTORS/);
        assert.throws(() => getVectorSpace(db, "fake", 4), /CAIRN_NO_VECTORS/);
        assert.throws(() => listVectorSpaces(db), /CAIRN_NO_VECTORS/);
        assert.throws(
          () => upsertVector(db, fakeSpace, 1, embedding, { scope: "default", live: true, createdAt: Date.now() }),
          /CAIRN_NO_VECTORS/,
        );
        assert.throws(() => setVectorLive(db, fakeSpace, 1, true), /CAIRN_NO_VECTORS/);
        assert.throws(() => deleteVector(db, fakeSpace, 1), /CAIRN_NO_VECTORS/);
        assert.throws(() => knn(db, fakeSpace, embedding, { k: 5 }), /CAIRN_NO_VECTORS/);
      } finally {
        db.close();
      }
    });
  } finally {
    if (previous === undefined) {
      delete process.env["CAIRN_NO_VECTORS"];
    } else {
      process.env["CAIRN_NO_VECTORS"] = previous;
    }
  }
});

test("two model ids that sanitize identically both register, get different table names, and stay isolated under KNN", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const spaceA = ensureVectorSpace(db, "bge-small-en-v1.5", 3);
      const spaceB = ensureVectorSpace(db, "bge_small_en_v1.5", 3);

      // Regression test for the table-name collision found in review: this
      // must fail if `deriveTableName` stops appending a digest of the
      // exact model id, because both ids sanitize to the same string.
      assert.notEqual(spaceA.tableName, spaceB.tableName);

      upsertVector(db, spaceA, 1, vec(1, 0, 0), { scope: "default", live: true, createdAt: Date.now() });

      const hitsInA = knn(db, spaceA, vec(1, 0, 0), { k: 10 });
      assert.equal(hitsInA.length, 1);
      assert.equal(hitsInA[0]?.memorySeq, 1);

      const hitsInB = knn(db, spaceB, vec(1, 0, 0), { k: 10 });
      assert.equal(hitsInB.length, 0);
    } finally {
      db.close();
    }
  });
});

test("a model id containing uppercase, slashes, colons and dots derives a table name matching the required pattern", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const space = ensureVectorSpace(db, "openai:text-embedding-3-small/v1.Foo", 6);
      assert.match(space.tableName, /^vec_[a-z0-9_]+_\d+_[0-9a-f]{8}$/);
    } finally {
      db.close();
    }
  });
});

test("assertTableName rejects a hand-built VectorSpaceRef with a malformed table name in knn and in a write path", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const maliciousSpace: VectorSpaceRef = {
        id: 1,
        modelId: "evil",
        dim: 3,
        tableName: "evil; DROP TABLE memories;--",
      };
      const embedding = vec(1, 2, 3);

      assert.throws(() => knn(db, maliciousSpace, embedding, { k: 5 }), /vector table name .* is invalid/);
      assert.throws(
        () =>
          upsertVector(db, maliciousSpace, 1, embedding, { scope: "default", live: true, createdAt: Date.now() }),
        /vector table name .* is invalid/,
      );
    } finally {
      db.close();
    }
  });
});

test("memorySeqsMissingVectors returns memories with no vector row, oldest seq first", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const space = ensureVectorSpace(db, "missing-vectors-model", 2);
      const seq1 = insertMemoryRow(db, { id: "m1" });
      const seq2 = insertMemoryRow(db, { id: "m2" });
      const seq3 = insertMemoryRow(db, { id: "m3" });

      upsertVector(db, space, seq2, vec(1, 0), { scope: "default", live: true, createdAt: Date.now() });

      const missing = memorySeqsMissingVectors(db, space);
      assert.deepEqual(missing, [seq1, seq3]);
    } finally {
      db.close();
    }
  });
});

test("memorySeqsMissingVectors excludes soft-deleted and superseded memories", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const space = ensureVectorSpace(db, "missing-vectors-excl-model", 2);
      const seqLive = insertMemoryRow(db, { id: "live" });
      insertMemoryRow(db, { id: "deleted", deletedAt: Date.now() });
      insertMemoryRow(db, { id: "superseded", validUntil: Date.now() });

      const missing = memorySeqsMissingVectors(db, space);
      assert.deepEqual(missing, [seqLive]);
    } finally {
      db.close();
    }
  });
});

test("memorySeqsMissingVectors returns an empty array when nothing is missing, and respects the limit clamp", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const space = ensureVectorSpace(db, "missing-vectors-clamp-model", 2);
      const seq1 = insertMemoryRow(db, { id: "c1" });
      upsertVector(db, space, seq1, vec(1, 0), { scope: "default", live: true, createdAt: Date.now() });
      assert.deepEqual(memorySeqsMissingVectors(db, space), []);

      for (let i = 2; i <= 6; i++) {
        insertMemoryRow(db, { id: `c${i}` });
      }
      const limited = memorySeqsMissingVectors(db, space, 2);
      assert.equal(limited.length, 2);

      const zeroOrNegative = memorySeqsMissingVectors(db, space, 0);
      assert.equal(zeroOrNegative.length, 5);
    } finally {
      db.close();
    }
  });
});

test("countMemoriesMissingVectors reports the true backlog size beyond memorySeqsMissingVectors's 500-row clamp", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const space = ensureVectorSpace(db, "count-missing-model", 2);
      const total = 600;
      db.tx(() => {
        for (let i = 0; i < total; i++) {
          insertMemoryRow(db, { id: `count-${i}` });
        }
      });

      assert.equal(countMemoriesMissingVectors(db, space), total);
      assert.equal(memorySeqsMissingVectors(db, space, 500).length, 500, "sanity: the row-materialising query does clamp at 500");

      const seq1 = db.q("select seq from memories where id = ?").get("count-0");
      upsertVector(db, space, Number(seq1?.["seq"]), vec(1, 0), { scope: "default", live: true, createdAt: Date.now() });

      assert.equal(countMemoriesMissingVectors(db, space), total - 1);
    } finally {
      db.close();
    }
  });
});

test("countMemoriesMissingVectors excludes soft-deleted and superseded memories, like memorySeqsMissingVectors", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const space = ensureVectorSpace(db, "count-missing-excl-model", 2);
      insertMemoryRow(db, { id: "live" });
      insertMemoryRow(db, { id: "deleted", deletedAt: Date.now() });
      insertMemoryRow(db, { id: "superseded", validUntil: Date.now() });

      assert.equal(countMemoriesMissingVectors(db, space), 1);
    } finally {
      db.close();
    }
  });
});

test("with CAIRN_NO_VECTORS=1, countMemoriesMissingVectors throws mentioning the disabled reason", () => {
  const previous = process.env["CAIRN_NO_VECTORS"];
  process.env["CAIRN_NO_VECTORS"] = "1";
  try {
    withTempDir((dir) => {
      const db = openDb({ path: tempDbPath(dir) });
      try {
        const fakeSpace: VectorSpaceRef = { id: 1, modelId: "fake", dim: 4, tableName: "vec_fake_4" };
        assert.throws(() => countMemoriesMissingVectors(db, fakeSpace), /CAIRN_NO_VECTORS/);
      } finally {
        db.close();
      }
    });
  } finally {
    if (previous === undefined) {
      delete process.env["CAIRN_NO_VECTORS"];
    } else {
      process.env["CAIRN_NO_VECTORS"] = previous;
    }
  }
});

test("listVectorSpaces respects a limit and clamps to a sane default when omitted or invalid", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      ensureVectorSpace(db, "list-clamp-a", 2);
      ensureVectorSpace(db, "list-clamp-b", 2);
      ensureVectorSpace(db, "list-clamp-c", 2);

      const limited = listVectorSpaces(db, 2);
      assert.equal(limited.length, 2);

      const defaulted = listVectorSpaces(db);
      assert.equal(defaulted.length, 3);

      const zeroLimit = listVectorSpaces(db, 0);
      assert.equal(zeroLimit.length, 3);
    } finally {
      db.close();
    }
  });
});
