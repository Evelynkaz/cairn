// The BUILD_BRIEF §7 hybrid pipeline: FTS5 branch ⨁ vector-KNN branch ->
// RRF fuse -> recency/importance/relevance re-rank -> MMR for diversity.
// This is the module `recall` (and, via context.ts, `get_context`) sits
// directly on top of.

import type { CairnDb } from "../storage/db.js";
import type { SqlValue } from "../storage/driver/index.js";
import { num, numOrNull, str } from "../storage/repositories/row.js";
import { knn, getVectorsBySeq } from "../storage/repositories/vectors.js";
import type { VectorSpaceRef } from "../storage/repositories/vectors.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { ftsSearch } from "./fts.js";
import { rrfFuse, RRF_K } from "./rrf.js";
import { rerank } from "./rerank.js";
import type { RerankItem, RerankWeights } from "./rerank.js";
import { mmr, cosineSimilarity } from "./mmr.js";
import type { MmrCandidate } from "./mmr.js";

export interface SearchDeps {
  provider?: EmbeddingProvider | null;
  space?: VectorSpaceRef | null;
}

export interface SearchOptions {
  scope?: string;
  tags?: string[];
  /** How many results come back. Default 10, clamped to 50. */
  limit?: number;
  /** Per-branch fan-out BEFORE RRF fusion. Default 50, clamped to 200. See
      the module comment on `search()` for why this must stay independent
      of `limit`. */
  candidateLimit?: number;
  weights?: Partial<RerankWeights>;
  mmrLambda?: number;
  now?: number;
  /** A RELATIVE floor on the normalised RRF relevance (0..1): each fused
      candidate's score is normalised against the TOP fused score of THIS
      call's own result set (see `maxScore` below), so the single
      best-ranked candidate in any non-empty result always has relevance
      exactly 1.0 and always clears this floor. That means minRelevance can
      only ever SHRINK a result set, never EMPTY one — it is not, on its
      own, an absolute quality gate, whatever its name suggests. Absolute
      gating comes from other, independent layers instead: fts.ts's
      stopword filter (a query with no content words returns nothing at
      all), its relative bm25 floor within the FTS branch, and
      `minCoverage` below (how much of the query's content a candidate's
      text actually contains — corpus- and rank-independent, so it CAN
      empty a result set). Starting-point default, NOT a tuned result
      (§14): low enough to let a genuinely weak-but-real match through,
      high enough to cut the pure stopword-driven noise a fused candidate
      with no real relevance signal produces. `get_context` should pass a
      stricter value than `recall`'s default. */
  minRelevance?: number;
  /** Fraction (0..1) of the query's content terms (fts.ts's `contentTerms`
      — the same stopword-filtered list `toMatchQuery` builds MATCH from) an
      FTS-branch candidate's text must contain to survive, applied per-hit
      INSIDE the FTS branch, before fusion. This is the absolute,
      corpus-independent complement `minRelevance` cannot be on its own
      (see that option's doc): matching one word out of a four-word
      question is not, by itself, an answer to it, no matter how it ranks
      against the rest of the store. Vector-branch hits have no term
      coverage by nature — a semantic match is exactly the case where the
      candidate's words legitimately differ from the query's — so they are
      EXEMPT from this floor entirely, never silently scored 0 (which would
      delete the vector branch's whole reason for existing); see where this
      is applied in `search()` below. Starting-point default
      (`DEFAULT_MIN_COVERAGE`), NOT a tuned result (§14): permissive,
      because an explicit, deliberate query (`recall`) tolerates a loose
      match the user asked for — `get_context` uses a stricter value, see
      `DEFAULT_CONTEXT_MIN_COVERAGE` in context.ts. */
  minCoverage?: number;
}

export interface RerankParts {
  relevance: number;
  recency: number;
  importance: number;
  access: number;
}

export interface SearchHit {
  id: string;
  seq: number;
  text: string;
  scope: string;
  tags: string[];
  importance: number;
  createdAt: number;
  lastAccessed: number | null;
  accessCount: number;
  score: number;
  parts: RerankParts;
  /** Provenance: the 1-based rank this id achieved in each branch's own
      ranked list, or null if the branch never surfaced it at all. Mirrors
      `FusedItem.ranks` — see rrf.ts. */
  sources: { fts: number | null; vector: number | null };
  /** The FTS branch's `FtsHit.coverage` for this hit (see fts.ts), or null
      when the FTS branch never surfaced it at all — a hit sourced purely
      from the vector branch has no term-coverage signal by nature (see
      `SearchOptions.minCoverage`). Exposed for the dashboard and a future
      tuning script, not consumed further by the pipeline itself past the
      `minCoverage` filter already applied to the FTS branch. */
  coverage: number | null;
}

export interface SearchResult {
  /** In MMR selection order, NOT score-descending order — consumers that
      read this array positionally rely on that. */
  hits: SearchHit[];
  /** True only when the vector branch was attempted and failed (a thrown
      `embed()`). FTS-only mode with no provider/space at all is a fully
      supported mode (BUILD_BRIEF §2), not a degradation, so it leaves this
      false. */
  degraded: boolean;
  degradedReason: string | null;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_CANDIDATE_LIMIT = 50;
const MAX_CANDIDATE_LIMIT = 200;

// Starting-point default, NOT a tuned result (§14): low enough to let a
// weak-but-real match through, high enough to drop a fused candidate whose
// only support is noise (see SearchOptions.minRelevance). Exported so
// `get_context` (context.ts) can assert its own default sits strictly
// above this one, rather than mirroring the literal.
export const DEFAULT_MIN_RELEVANCE = 0.1;

// Starting-point default, NOT a tuned result (§14): permissive, because
// `recall` is an explicit, deliberate query the user chose to run, and a
// hit sharing only a modest fraction of its content words still deserves a
// glance (see SearchOptions.minCoverage). `get_context` uses a stricter
// value — see DEFAULT_CONTEXT_MIN_COVERAGE in context.ts.
export const DEFAULT_MIN_COVERAGE = 0.2;

function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function clampCandidateLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return DEFAULT_CANDIDATE_LIMIT;
  return Math.min(Math.floor(limit), MAX_CANDIDATE_LIMIT);
}

function clampMinRelevance(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MIN_RELEVANCE;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clampMinCoverage(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MIN_COVERAGE;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function matchesTags(rowTags: string[], required: string[]): boolean {
  return required.every((tag) => rowTags.includes(tag));
}

interface LoadedRow {
  id: string;
  seq: number;
  text: string;
  scope: string;
  tags: string[];
  importance: number;
  createdAt: number;
  lastAccessed: number | null;
  accessCount: number;
}

function fetchTagsByIds(db: CairnDb, ids: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .q(`SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${placeholders}) ORDER BY tag`)
    .all(...ids);
  for (const row of rows) {
    const id = str(row, "memory_id");
    const list = result.get(id);
    if (list) {
      list.push(str(row, "tag"));
    } else {
      result.set(id, [str(row, "tag")]);
    }
  }
  return result;
}

// Loads full rows for a set of memory seqs THROUGH memories_live, exactly
// like fts.ts does for its own hits. This is what makes "a vector row for a
// memory soft-deleted since indexing must not surface" hold: a seq that is
// no longer live simply has no entry in the returned map, regardless of
// whether the vec0 table's own (best-effort, periodically-synced) `live`
// column still says 1. That column is never trusted here — see worker.ts's
// syncVectorLiveness for why it can lag.
function loadRowsBySeq(db: CairnDb, seqs: number[]): Map<number, LoadedRow> {
  const result = new Map<number, LoadedRow>();
  if (seqs.length === 0) return result;
  const placeholders = seqs.map(() => "?").join(", ");
  const rows = db
    .q(
      `SELECT seq, id, text, scope, importance, created_at, last_accessed, access_count
       FROM memories_live WHERE seq IN (${placeholders})`,
    )
    .all(...seqs);
  const tagsById = fetchTagsByIds(
    db,
    rows.map((row) => str(row, "id")),
  );
  for (const row of rows) {
    const id = str(row, "id");
    result.set(num(row, "seq"), {
      id,
      seq: num(row, "seq"),
      text: str(row, "text"),
      scope: str(row, "scope"),
      tags: tagsById.get(id) ?? [],
      importance: num(row, "importance"),
      createdAt: num(row, "created_at"),
      lastAccessed: numOrNull(row, "last_accessed"),
      accessCount: num(row, "access_count"),
    });
  }
  return result;
}

// Cap for the exact tag-filtered vector ranking path below: below this many
// live memories matching all requested tags, exact cosine-similarity
// ranking against every one of them is cheap and never misses a match;
// beyond it, fall back to knn's approximate index search, same as the
// untagged path.
const TAG_PRERESOLVE_CAP = MAX_CANDIDATE_LIMIT;

// Resolves the live seqs matching ALL requested tags (and scope, if given)
// directly in SQL — the same one-EXISTS-per-tag AND pattern fts.ts and
// memories.ts use — capped at `cap`. Returns null if more than `cap` rows
// match, signalling the caller to fall back to the approximate knn path
// instead of loading and ranking an unbounded set.
function resolveTagMatchingSeqs(
  db: CairnDb,
  tags: string[],
  scope: string | undefined,
  cap: number,
): number[] | null {
  const conditions: string[] = [];
  const params: SqlValue[] = [];
  for (const tag of tags) {
    conditions.push(`EXISTS (SELECT 1 FROM memory_tags mt WHERE mt.memory_id = m.id AND mt.tag = ?)`);
    params.push(tag);
  }
  if (scope !== undefined) {
    conditions.push("m.scope = ?");
    params.push(scope);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.q(`SELECT seq FROM memories_live m ${where} LIMIT ?`).all(...params, cap + 1);
  if (rows.length > cap) return null;
  return rows.map((row) => num(row, "seq"));
}

function tieBreak(aId: string, aScore: number, bId: string, bScore: number): number {
  if (bScore !== aScore) return bScore - aScore;
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/**
 * The BUILD_BRIEF §7 hybrid retrieval pipeline:
 *
 *   FTS5 branch ⨁ vector-KNN branch -> RRF fuse (k≈10) ->
 *   recency/importance/relevance re-rank -> MMR for diversity -> `limit`.
 *
 * `candidateLimit` (default 50, clamped to 200) is the per-branch fan-out
 * BEFORE fusion; `limit` (default 10, clamped to 50) is what comes back.
 * These are deliberately different knobs: fusing only the final page would
 * make RRF meaningless — it needs a wider candidate pool to rank within
 * than it ultimately returns, or "reciprocal rank" degenerates to "whatever
 * order the last page happened to arrive in".
 *
 * The vector branch is optional and can never make search unavailable: it
 * is skipped outright when there is no provider, no space, or
 * `db.capabilities.vectors` is false (BUILD_BRIEF §2 makes keyword-only a
 * fully supported mode, not a degradation). If `provider.embed()` THROWS
 * (a hosted API down, a broken local runtime), the error is caught, the
 * vector branch is dropped for this call, and it is reported through
 * `degraded`/`degradedReason` — never propagated. A dead embedding
 * provider must degrade the QUALITY of search, not its availability.
 */
export async function search(
  db: CairnDb,
  query: string,
  options: SearchOptions = {},
  deps: SearchDeps = {},
): Promise<SearchResult> {
  const now = options.now ?? Date.now();
  const limit = clampSearchLimit(options.limit);
  const candidateLimit = clampCandidateLimit(options.candidateLimit);
  const scope = options.scope;
  const tags = options.tags ?? [];

  let degraded = false;
  let degradedReason: string | null = null;

  // --- FTS branch ---
  // minCoverage is applied HERE, per-hit, before this branch's ids ever
  // reach fusion — see SearchOptions.minCoverage for why this (not
  // minRelevance) is the layer that can genuinely empty a result set.
  const minCoverage = clampMinCoverage(options.minCoverage);
  const ftsHits = ftsSearch(db, query, { scope, tags, limit: candidateLimit }).filter(
    (hit) => hit.coverage >= minCoverage,
  );
  const rowsById = new Map<string, LoadedRow>();
  const coverageById = new Map<string, number>();
  for (const hit of ftsHits) {
    rowsById.set(hit.id, {
      id: hit.id,
      seq: hit.seq,
      text: hit.text,
      scope: hit.scope,
      tags: hit.tags,
      importance: hit.importance,
      createdAt: hit.createdAt,
      lastAccessed: hit.lastAccessed,
      accessCount: hit.accessCount,
    });
    coverageById.set(hit.id, hit.coverage);
  }
  const ftsIds = ftsHits.map((hit) => hit.id);

  // --- vector branch (optional; both filters applied — see module docs) ---
  const provider = deps.provider ?? null;
  const space = deps.space ?? null;
  const vectorBranchAvailable = provider !== null && space !== null && db.capabilities.vectors;
  const vectorIds: string[] = [];

  if (vectorBranchAvailable && provider !== null && space !== null) {
    try {
      const [queryVector] = await provider.embed([query]);
      if (queryVector) {
        if (tags.length > 0) {
          // `knn` filters `scope` structurally, but tags cannot be
          // expressed in vec0. Filtering the tag AFTER a plain
          // knn(candidateLimit) fan-out is wrong at the API-contract level,
          // not just approximate: a tagged memory ranked below
          // candidateLimit by raw vector distance is cut before the tag
          // filter ever sees it, so a tag the dashboard shows can come back
          // with zero hits. Pre-resolving the (capped) tag-matching seq set
          // in SQL and ranking it exactly by cosine similarity fixes that
          // for any corpus small enough to fit the cap; beyond the cap,
          // fall back to knn at its own maximum fan-out (not the caller's
          // candidateLimit) and filter afterward, same as before — still
          // approximate at extreme scale, but far less likely to starve a
          // real tagged match than using the requested candidateLimit.
          const preresolved = resolveTagMatchingSeqs(db, tags, scope, TAG_PRERESOLVE_CAP);
          if (preresolved !== null) {
            const vectors = getVectorsBySeq(db, space, preresolved);
            const ranked = preresolved
              .map((seq) => {
                const vector = vectors.get(seq);
                return vector ? { memorySeq: seq, distance: 1 - cosineSimilarity(queryVector, vector) } : null;
              })
              .filter((hit): hit is { memorySeq: number; distance: number } => hit !== null)
              .sort((a, b) => a.distance - b.distance);
            const loaded = loadRowsBySeq(
              db,
              ranked.map((hit) => hit.memorySeq),
            );
            for (const hit of ranked) {
              const row = loaded.get(hit.memorySeq);
              if (!row) continue; // soft-deleted/superseded since indexing: never surfaces (§10)
              vectorIds.push(row.id);
              if (!rowsById.has(row.id)) rowsById.set(row.id, row);
            }
          } else {
            const knnHits = knn(db, space, queryVector, { k: MAX_CANDIDATE_LIMIT, scope });
            const loaded = loadRowsBySeq(
              db,
              knnHits.map((hit) => hit.memorySeq),
            );
            for (const hit of knnHits) {
              const row = loaded.get(hit.memorySeq);
              if (!row) continue;
              if (!matchesTags(row.tags, tags)) continue;
              vectorIds.push(row.id);
              if (!rowsById.has(row.id)) rowsById.set(row.id, row);
            }
          }
        } else {
          const knnHits = knn(db, space, queryVector, { k: candidateLimit, scope });
          const loaded = loadRowsBySeq(
            db,
            knnHits.map((hit) => hit.memorySeq),
          );
          for (const hit of knnHits) {
            const row = loaded.get(hit.memorySeq);
            if (!row) continue; // soft-deleted/superseded since indexing: never surfaces (§10)
            vectorIds.push(row.id);
            if (!rowsById.has(row.id)) rowsById.set(row.id, row);
          }
        }
      } else {
        // A provider that resolves without throwing but hands back no
        // vector for the query (e.g. a hosted gateway returning an empty
        // embeddings array on a quota error) is indistinguishable from the
        // supported FTS-only mode unless reported explicitly — it must
        // degrade search QUALITY visibly, not silently fall back to
        // `degraded: false`.
        degraded = true;
        degradedReason = `embedding provider "${provider.name}" returned no vector for the query`;
      }
    } catch (error) {
      degraded = true;
      degradedReason = error instanceof Error ? error.message : String(error);
      // vectorIds stays empty: fall back to FTS-only for this call.
    }
  }

  // --- RRF fuse ---
  const fused = rrfFuse([ftsIds, vectorIds], RRF_K);
  if (fused.length === 0) {
    return { hits: [], degraded, degradedReason };
  }

  const ranksById = new Map(fused.map((item) => [item.id, item.ranks]));
  // `relevance` fed to rerank() is expected in 0..1: raw RRF scores are tiny
  // (they scale with 1/k and the number of lists) and carry no natural
  // upper bound, so normalise by the top score. fused is sorted score-desc,
  // so fused[0] IS the max; the `> 0` guard is defensive only (a nonempty
  // fused list always has a positive top score).
  const maxScore = fused[0]!.score;
  const relevanceById = new Map(fused.map((item) => [item.id, maxScore > 0 ? item.score / maxScore : 0]));

  // --- re-rank (recency/importance/relevance/access blend) ---
  const rerankInput: RerankItem[] = fused.map((item) => {
    const row = rowsById.get(item.id);
    if (!row) {
      throw new Error(`search: fused id ${item.id} has no loaded row — this is a pipeline bug`);
    }
    return {
      id: row.id,
      relevance: relevanceById.get(item.id) ?? 0,
      createdAt: row.createdAt,
      importance: row.importance,
      lastAccessed: row.lastAccessed,
      accessCount: row.accessCount,
    };
  });
  // Relative relevance floor (see SearchOptions.minRelevance — RELATIVE to
  // this call's own top fused score, so it shrinks this result set but can
  // never empty it on its own). Applied to the SAME normalised relevance
  // fed into rerank() above, after re-rank has had its say but before MMR
  // spends any work diversifying a set that is mostly noise.
  const minRelevance = clampMinRelevance(options.minRelevance);
  const reranked = rerank(rerankInput, now, options.weights)
    .filter((r) => r.relevance >= minRelevance)
    .sort((a, b) => tieBreak(a.id, a.score, b.id, b.score));

  if (reranked.length === 0) {
    return { hits: [], degraded, degradedReason };
  }

  // --- MMR (diversity), using each candidate's stored vector where one
  // exists (regardless of which branch surfaced it) and null where it does
  // not; a not-yet-indexed memory therefore stays eligible. See mmr.ts. ---
  let vectorsBySeq = new Map<number, Float32Array>();
  if (space !== null && db.capabilities.vectors) {
    vectorsBySeq = getVectorsBySeq(
      db,
      space,
      reranked.map((r) => rowsById.get(r.id)!.seq),
    );
  }

  const mmrCandidates: MmrCandidate[] = reranked.map((r) => {
    const row = rowsById.get(r.id)!;
    return { id: r.id, relevance: r.score, vector: vectorsBySeq.get(row.seq) ?? null };
  });
  const selectedIds = mmr(mmrCandidates, limit, options.mmrLambda);

  const rerankedById = new Map(reranked.map((r) => [r.id, r]));
  const hits: SearchHit[] = selectedIds.map((id) => {
    const r = rerankedById.get(id)!;
    const row = rowsById.get(id)!;
    const ranks = ranksById.get(id) ?? [null, null];
    return {
      id: row.id,
      seq: row.seq,
      text: row.text,
      scope: row.scope,
      tags: row.tags,
      importance: row.importance,
      createdAt: row.createdAt,
      lastAccessed: row.lastAccessed,
      accessCount: row.accessCount,
      score: r.score,
      parts: r.parts,
      sources: { fts: ranks[0] ?? null, vector: ranks[1] ?? null },
      coverage: coverageById.get(id) ?? null,
    };
  });

  return { hits, degraded, degradedReason };
}
