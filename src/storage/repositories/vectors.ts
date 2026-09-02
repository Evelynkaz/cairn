// Vector spaces: one vec0 virtual table per (model_id, dim) pair, created
// lazily and registered in `vector_spaces` (see migrations/001-init.ts for
// why no vec0 table is created at migration time). vec0 fixes the embedding
// dimension at DDL time, and BUILD_BRIEF §3 requires we never KNN across
// mismatched models -- keeping one table per space is what makes that
// guarantee structural rather than a convention callers must remember, and
// it is also what turns a provider switch into a background re-embed
// instead of a destructive migration.

import { createHash } from "node:crypto";
import type { CairnDb } from "../db.js";
import type { Row, SqlValue } from "../driver/index.js";

export interface VectorSpaceRef {
  id: number;
  modelId: string;
  dim: number;
  tableName: string;
}

const DEFAULT_K = 10;
const MAX_K = 200;
const TABLE_NAME_PATTERN = /^vec_[a-z0-9_]+_\d+_[0-9a-f]{8}$/;

const LIST_SPACES_DEFAULT_LIMIT = 50;
const LIST_SPACES_MAX_LIMIT = 200;

// Re-embedding is a background batch job (BUILD_BRIEF §3), not a UI page,
// so its ceiling is set higher than an ordinary list limit.
const MISSING_VECTORS_DEFAULT_LIMIT = 50;
const MISSING_VECTORS_MAX_LIMIT = 500;

function assertVectorsEnabled(db: CairnDb): void {
  if (!db.capabilities.vectors) {
    throw new Error(
      `vector operations are unavailable (capabilities.vectorError: ${db.capabilities.vectorError ?? "unknown"})`,
    );
  }
}

// Defence in depth: `VectorSpaceRef.tableName` is a plain string field, so
// a hand-built ref (a caller could assemble one directly, as the disabled-
// vectors test does) could carry an arbitrary value that ends up
// interpolated into raw SQL below. `ensureVectorSpace` is currently the
// only writer of `vector_spaces` and already validates on the way in, but
// every function that interpolates a table name re-checks it here anyway.
export function assertTableName(name: string): string {
  if (!TABLE_NAME_PATTERN.test(name)) {
    throw new Error(`vector table name "${name}" is invalid`);
  }
  return name;
}

// DDL cannot be parameterized, so the table name is derived from caller
// input and must be validated before interpolation.
function deriveTableName(modelId: string, dim: number): string {
  if (!Number.isSafeInteger(dim) || dim <= 0) {
    throw new Error(`vector dim must be a positive safe integer, got ${dim}`);
  }
  const sanitized = modelId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (sanitized.length === 0) {
    throw new Error(`model id "${modelId}" sanitizes to an empty table name`);
  }
  // Sanitizing collapses distinct model ids that differ only in separators
  // (e.g. "bge-small-en-v1.5" vs "bge_small_en_v1.5") onto the same string,
  // which would silently alias two different embedding spaces onto one
  // vec0 table. The digest is over the exact model id, so it disambiguates
  // them while staying deterministic across machines / a copied database
  // file. The sanitized part is kept too, since BUILD_BRIEF §1/§10 tell
  // users the .db file is theirs to inspect and a readable name helps.
  const suffix = createHash("sha256").update(modelId).digest("hex").slice(0, 8);
  const tableName = `vec_${sanitized}_${dim}_${suffix}`;
  return assertTableName(tableName);
}

function toRef(row: Row): VectorSpaceRef {
  return {
    id: Number(row["id"]),
    modelId: String(row["model_id"]),
    dim: Number(row["dim"]),
    tableName: assertTableName(String(row["table_name"])),
  };
}

function toBlob(space: VectorSpaceRef, embedding: Float32Array): Uint8Array {
  if (embedding.length !== space.dim) {
    throw new Error(
      `embedding has length ${embedding.length}, but vector space "${space.tableName}" expects dim ${space.dim}`,
    );
  }
  return new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

// Reinterprets a stored BLOB's bytes as a Float32Array. ArrayBuffer#slice
// copies into a fresh, zero-offset buffer, so the result is always
// correctly aligned regardless of where the driver's Uint8Array started.
function blobToVector(blob: Uint8Array): Float32Array {
  const buffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(buffer);
}

// getVectorsBySeq is used both for MMR's diversity pass over a whole fused
// candidate page and for search.ts's exact tag-filtered ranking path (see
// module docs there), so its cap has to cover the sum of a two-branch
// candidate pool at MAX_K each, plus the tag pre-resolve cap — comfortably
// above any of those individually, nowhere near "the whole store".
const GET_VECTORS_MAX_SEQS = 1000;

function clampSpacesLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return LIST_SPACES_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), LIST_SPACES_MAX_LIMIT);
}

function clampMissingVectorsLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return MISSING_VECTORS_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), MISSING_VECTORS_MAX_LIMIT);
}

export function ensureVectorSpace(db: CairnDb, modelId: string, dim: number): VectorSpaceRef {
  assertVectorsEnabled(db);
  const tableName = deriveTableName(modelId, dim);
  return db.tx(() => {
    const existing = db
      .q("select id, model_id, dim, table_name from vector_spaces where model_id = ? and dim = ?")
      .get(modelId, dim);
    if (existing) {
      return toRef(existing);
    }
    // `importance` is deliberately NOT a metadata column here: it is a REAL
    // value, and the driver's integer normalization (driver/types.ts rule
    // 2) would make it ambiguous under vec0's metadata typing. BUILD_BRIEF
    // §7 applies importance during the JS re-rank AFTER RRF fusion, never
    // as a vector-store pre-filter, so it has no reason to live here.
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
        memory_seq INTEGER PRIMARY KEY,
        embedding FLOAT[${dim}] distance_metric=cosine,
        scope TEXT,
        live INTEGER,
        created_at INTEGER
      )`,
    );
    const now = Date.now();
    const result = db
      .q("insert into vector_spaces (model_id, dim, table_name, created_at) values (?, ?, ?, ?)")
      .run(modelId, dim, tableName, now);
    return { id: result.lastInsertRowid, modelId, dim, tableName };
  });
}

export function getVectorSpace(db: CairnDb, modelId: string, dim: number): VectorSpaceRef | undefined {
  assertVectorsEnabled(db);
  const row = db
    .q("select id, model_id, dim, table_name from vector_spaces where model_id = ? and dim = ?")
    .get(modelId, dim);
  return row ? toRef(row) : undefined;
}

export function listVectorSpaces(db: CairnDb, limit?: number): VectorSpaceRef[] {
  assertVectorsEnabled(db);
  // Small local clamp rather than a shared paging helper: one is being
  // added elsewhere concurrently. Should be unified with it later.
  const clamped = clampSpacesLimit(limit);
  return db
    .q("select id, model_id, dim, table_name from vector_spaces order by id limit ?")
    .all(clamped)
    .map(toRef);
}

export function upsertVector(
  db: CairnDb,
  space: VectorSpaceRef,
  memorySeq: number,
  embedding: Float32Array,
  meta: { scope: string; live: boolean; createdAt: number },
): void {
  assertVectorsEnabled(db);
  const tableName = assertTableName(space.tableName);
  const blob = toBlob(space, embedding);
  db.tx(() => {
    // vec0 rejects a duplicate primary key ("UNIQUE constraint failed on
    // ... primary key"), so a blind insert breaks on re-embedding.
    db.q(`delete from ${tableName} where memory_seq = ?`).run(memorySeq);
    db.q(
      `insert into ${tableName} (memory_seq, embedding, scope, live, created_at) values (?, ?, ?, ?, ?)`,
    ).run(memorySeq, blob, meta.scope, meta.live ? 1 : 0, meta.createdAt);
  });
}

export function setVectorLive(db: CairnDb, space: VectorSpaceRef, memorySeq: number, live: boolean): void {
  assertVectorsEnabled(db);
  const tableName = assertTableName(space.tableName);
  db.q(`update ${tableName} set live = ? where memory_seq = ?`).run(live ? 1 : 0, memorySeq);
}

export function deleteVector(db: CairnDb, space: VectorSpaceRef, memorySeq: number): void {
  assertVectorsEnabled(db);
  const tableName = assertTableName(space.tableName);
  db.q(`delete from ${tableName} where memory_seq = ?`).run(memorySeq);
}

export function knn(
  db: CairnDb,
  space: VectorSpaceRef,
  embedding: Float32Array,
  options: { k?: number; scope?: string; live?: boolean } = {},
): { memorySeq: number; distance: number }[] {
  assertVectorsEnabled(db);
  const tableName = assertTableName(space.tableName);
  const blob = toBlob(space, embedding);
  const k = Math.min(MAX_K, Math.max(1, Math.trunc(options.k ?? DEFAULT_K)));

  const clauses = ["embedding match ?", "k = ?"];
  const params: SqlValue[] = [blob, k];
  if (options.scope !== undefined) {
    clauses.push("scope = ?");
    params.push(options.scope);
  }
  if (options.live !== undefined) {
    clauses.push("live = ?");
    params.push(options.live ? 1 : 0);
  }

  const sql = `select memory_seq, distance from ${tableName} where ${clauses.join(" and ")} order by distance asc`;
  return db
    .q(sql)
    .all(...params)
    .map((row) => ({ memorySeq: Number(row["memory_seq"]), distance: Number(row["distance"]) }));
}

// Batch-fetches the raw stored embedding for every given seq that has one.
// A seq with no row (not yet indexed) is simply absent from the result map
// -- callers treat that as "no vector for this candidate", not an error.
// This is the sanctioned way to read stored vectors back out by seq: it is
// the only function in this module that both validates the table name and
// hands back the decoded Float32Array, so callers (search.ts) never need
// their own copy of the table-name guard or the BLOB-decoding logic.
export function getVectorsBySeq(db: CairnDb, space: VectorSpaceRef, seqs: number[]): Map<number, Float32Array> {
  assertVectorsEnabled(db);
  const result = new Map<number, Float32Array>();
  if (seqs.length === 0) return result;
  if (seqs.length > GET_VECTORS_MAX_SEQS) {
    throw new Error(`getVectorsBySeq: ${seqs.length} seqs exceeds the ${GET_VECTORS_MAX_SEQS} cap`);
  }
  const tableName = assertTableName(space.tableName);
  const placeholders = seqs.map(() => "?").join(", ");
  const rows = db
    .q(`select memory_seq, embedding from ${tableName} where memory_seq in (${placeholders})`)
    .all(...seqs);
  for (const row of rows) {
    const blob = row["embedding"];
    if (blob instanceof Uint8Array) {
      result.set(Number(row["memory_seq"]), blobToVector(blob));
    }
  }
  return result;
}

// Feeds the background re-embed migration required by BUILD_BRIEF §3 when
// the embedding provider changes: finds memories that still need a vector
// row written in the given space. Reads memories_live (not memories), so a
// soft-deleted or superseded memory is never re-embedded.
export function memorySeqsMissingVectors(db: CairnDb, space: VectorSpaceRef, limit?: number): number[] {
  assertVectorsEnabled(db);
  const tableName = assertTableName(space.tableName);
  const clamped = clampMissingVectorsLimit(limit);
  const sql = `
    select m.seq as seq
    from memories_live m
    left join ${tableName} v on v.memory_seq = m.seq
    where v.memory_seq is null
    order by m.seq asc
    limit ?
  `;
  return db
    .q(sql)
    .all(clamped)
    .map((row) => Number(row["seq"]));
}

// Same anti-join as memorySeqsMissingVectors, but a count(*) instead of
// materialising rows: memorySeqsMissingVectors clamps to
// MISSING_VECTORS_MAX_LIMIT internally, so it cannot report a true backlog
// size once the backlog exceeds that clamp -- exactly the number a progress
// readout (IndexerProgress.remaining) needs.
export function countMemoriesMissingVectors(db: CairnDb, space: VectorSpaceRef): number {
  assertVectorsEnabled(db);
  const tableName = assertTableName(space.tableName);
  const sql = `
    select count(*) as c
    from memories_live m
    left join ${tableName} v on v.memory_seq = m.seq
    where v.memory_seq is null
  `;
  const row = db.q(sql).get();
  return Number(row?.["c"] ?? 0);
}
