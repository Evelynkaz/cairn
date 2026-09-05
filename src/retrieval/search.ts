// The BUILD_BRIEF §7 hybrid pipeline: FTS5 branch ⨁ vector-KNN branch ->
// RRF fuse -> recency/importance/relevance re-rank -> MMR for diversity.
// This is the module `recall` (and, via context.ts, `get_context`) sits
// directly on top of.

import type { CairnDb } from "../storage/db.js";
import type { SqlValue } from "../storage/driver/index.js";
import { bool, num, numOrNull, str } from "../storage/repositories/row.js";
import type { MemoryOrigin } from "../storage/types.js";
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
  /** A RELATIVE floor on RRF relevance (0..1), against the TOP fused score
      of THIS call's own result set only (`item.score / maxScore` — see
      `preNormRelevanceById` in `search()`): the single best-ranked candidate
      in any non-empty result always has relevance exactly 1.0 and always
      clears this floor. This is deliberately NOT the min-max-normalised
      relevance rerank() blends (see the comment above `relevanceById` in
      `search()`): min-max also pins the single WORST fused candidate to
      exactly 0 for every N, which would make this floor cut the worst
      survivor of every non-empty result set regardless of how good it
      actually is — the exact silent-loss regression this comment used to
      describe. On the max-only scale used here, a candidate only reads as
      low when it is genuinely far behind the leader on raw RRF score, so
      minRelevance can only ever SHRINK a result set, never EMPTY one — it
      is not, on its own, an absolute quality gate, whatever its name
      suggests. Absolute
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
  /** A cosine-DISTANCE ceiling applied to the vector branch alone, before
      fusion — the vector branch's own absolute floor, playing the same role
      `minCoverage` plays for the FTS branch (see that option's doc for why
      a vector hit is EXEMPT from `minCoverage`). Without it, `knn`'s k
      nearest neighbours enter fusion however far away they actually are:
      with no store memory genuinely related to the query, the "nearest"
      neighbours are still returned and can still rank at the very top of
      the fused, re-ranked result (§14 context pollution, in semantic mode).
      The vec0 tables this project creates all use `distance_metric=cosine`
      (repositories/vectors.ts), so distance here is `1 - cosine_similarity`
      — 0 for an identical direction, up to 2 for an opposite one. Real,
      semantically UNRELATED pairs from the local embedding models this
      project ships do not sit near that theoretical worst case: anisotropy
      in sentence embeddings means even unrelated pairs already share a
      baseline cosine similarity of roughly 0.6-0.75 (see mmr.ts's
      `cosineSimilarity` module doc), i.e. distance roughly 0.25-0.4.
      `DEFAULT_MAX_VECTOR_DISTANCE` sits below the bottom of that band, and
      `get_context`'s stricter default sits further below still — see
      `DEFAULT_CONTEXT_MAX_VECTOR_DISTANCE` in context.ts. Starting-point
      default, NOT a tuned result (§14): needs tuning against real
      transcripts and a real embedding model, like every other floor here. */
  maxVectorDistance?: number;
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
  /** The vector branch's raw cosine distance for this hit (see
      `SearchOptions.maxVectorDistance`), or null when the vector branch
      never surfaced it at all (an FTS-only hit, or vector search was
      unavailable/skipped/degraded for this call). Exposed for the same
      reason `coverage` is: so a caller can see WHY a semantic hit was kept,
      not just that it was. */
  vectorDistance: number | null;
  /** Provenance (BUILD_BRIEF §10/§14, see storage/store.ts's CallContext.origin
      and storage/types.ts's Memory.origin): 'user' for a direct
      remember/update/supersede, 'import' for anything written through
      importMemory or a vendor importer built on it, 'unknown' for a
      pre-migration row. Populated here from the memories table for every
      hit `search()` itself produces. Optional because not every SearchHit
      in this codebase is built by `search()` — src/retrieval/context.ts's
      empty-query ("what matters right now") fallback constructs its own
      hits directly from a recency/importance pool and does not carry this;
      a caller rendering this field must treat `undefined` the same as
      'unknown' (least-trusted), never as 'user'. */
  origin?: MemoryOrigin;
  /** Whether a human has approved this (non-'user') memory for automatic
      injection (see Memory.approved). Same optionality caveat as `origin`
      above. */
  approved?: boolean;
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

// Shared by src/dashboard/api.ts and src/mcp/tools.ts: `degradedReason`
// above is whatever text an HTTP-backed embedding provider's failure
// carried out of this module's own catch block, which can embed
// `${response.status} ${readBodyExcerpt(...)}` of the upstream response --
// a provider URL, a host name, or raw upstream error body. That text must
// never reach an HTTP or MCP caller verbatim (the no-echo rule both of
// those layers apply over this daemon), so both consumers replace it with
// this fixed, safe value instead. `degraded` (the boolean) is untouched;
// it is already safe and is what callers need. `rawReason`, when given, is
// logged to stderr only -- for whoever operates this daemon -- never
// forwarded to the caller.
export type SafeDegradedReason = "embedding_failed" | null;
export function toSafeDegradedReason(degraded: boolean, rawReason: string | null = null): SafeDegradedReason {
  if (degraded && rawReason) {
    console.error(`degraded retrieval: ${rawReason}`);
  }
  return degraded ? "embedding_failed" : null;
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

// Starting-point default, NOT a tuned result (§14): see
// SearchOptions.maxVectorDistance for the full reasoning (unrelated pairs
// from the local embedding models this project ships sit at roughly
// 0.25-0.4 cosine distance; this default sits just below that band).
// `get_context` uses a stricter value — see
// DEFAULT_CONTEXT_MAX_VECTOR_DISTANCE in context.ts.
//
// UNVALIDATED against real embeddings, and there is reason to expect it
// runs hot: 0.24 distance requires cosine similarity >= 0.76, but for
// bge-small-en-v1.5 a genuinely good paraphrase routinely sits in the
// 0.75-0.85 similarity range — i.e. sometimes just below this floor. §14
// forbids tuning this against a self-run/invented corpus, so it is left as
// a starting point needing validation against real transcripts and a real
// embedding model before it can be trusted not to silently cut real
// matches. It is deliberately NOT surfaced through `degraded` when it
// empties a result set: an entirely unrelated corpus is expected, correct,
// non-degraded behaviour for this filter (see the regression test pinning
// exactly that in search.test.ts) and there is no way, from inside this
// function, to distinguish "genuinely unrelated" from "related, but this
// unvalidated threshold cut it anyway" — only a real embedding model
// evaluated against real transcripts can tell those apart.
export const DEFAULT_MAX_VECTOR_DISTANCE = 0.24;

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

// vec0 cosine distance ranges 0..2 in principle (see
// SearchOptions.maxVectorDistance); this only guards finiteness and
// non-negativity, not an upper bound, since a caller may deliberately pass
// a high value to admit everything.
function clampMaxVectorDistance(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return DEFAULT_MAX_VECTOR_DISTANCE;
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

export function fetchTagsByIds(db: CairnDb, ids: string[]): Map<string, string[]> {
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

// Looks up SearchHit.origin/approved for a bounded set of ids in one query
// -- `ids` is always this call's own final (post-MMR, post-`limit`) hit
// list, never an unbounded scan. Reads the `memories` table directly
// (not memories_live) purely for these two columns: a hit already resolved
// through memories_live by this point, so this is a provenance lookup, not
// a second liveness check.
function fetchProvenanceByIds(db: CairnDb, ids: string[]): Map<string, { origin: MemoryOrigin; approved: boolean }> {
  const result = new Map<string, { origin: MemoryOrigin; approved: boolean }>();
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db.q(`SELECT id, origin, approved FROM memories WHERE id IN (${placeholders})`).all(...ids);
  for (const row of rows) {
    result.set(str(row, "id"), { origin: str(row, "origin") as MemoryOrigin, approved: bool(row, "approved") });
  }
  return result;
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
 * is skipped outright when there is no provider, no space, `db.capabilities.
 * vectors` is false, or the provider and space disagree on `modelId`/`dim`
 * (BUILD_BRIEF §3 forbids KNN across mismatched models; a mismatch is
 * reported via `degraded`/`degradedReason`, same as any other skip). BUILD_
 * BRIEF §2 makes keyword-only a fully supported mode, not a degradation, so
 * a merely ABSENT provider/space leaves `degraded: false`. If
 * `provider.embed()` THROWS (a hosted API down, a broken local runtime),
 * the error is caught, the vector branch is dropped for this call, and it
 * is reported through `degraded`/`degradedReason` — never propagated. A
 * dead embedding provider must degrade the QUALITY of search, not its
 * availability.
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
  let vectorBranchAvailable = provider !== null && space !== null && db.capabilities.vectors;
  // BUILD_BRIEF §3: never KNN across mismatched models. `db.capabilities.
  // vectors` and a non-null provider/space only prove a vector store and a
  // provider both exist -- not that they are the SAME embedding space. A
  // provider/space pair that disagrees on modelId or dim would otherwise
  // run a full cross-model KNN silently (same dim, different model, is the
  // dangerous case: it doesn't even throw a dimension-mismatch error).
  if (vectorBranchAvailable && provider !== null && space !== null) {
    if (provider.modelId !== space.modelId || provider.dim !== space.dim) {
      vectorBranchAvailable = false;
      degraded = true;
      degradedReason =
        `embedding provider "${provider.modelId}" (dim ${provider.dim}) does not match ` +
        `vector space "${space.modelId}" (dim ${space.dim}); vector branch skipped`;
    }
  }
  const vectorIds: string[] = [];
  const vectorDistanceById = new Map<string, number>();
  const maxVectorDistance = clampMaxVectorDistance(options.maxVectorDistance);

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
              // maxVectorDistance is this branch's own absolute floor (see
              // SearchOptions.maxVectorDistance) -- applied here, before a
              // candidate ever reaches fusion, same as minCoverage for FTS.
              .filter((hit) => hit.distance <= maxVectorDistance)
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
              vectorDistanceById.set(row.id, hit.distance);
            }
          } else {
            const knnHits = knn(db, space, queryVector, { k: MAX_CANDIDATE_LIMIT, scope });
            const loaded = loadRowsBySeq(
              db,
              knnHits.map((hit) => hit.memorySeq),
            );
            for (const hit of knnHits) {
              if (hit.distance > maxVectorDistance) continue;
              const row = loaded.get(hit.memorySeq);
              if (!row) continue;
              if (!matchesTags(row.tags, tags)) continue;
              vectorIds.push(row.id);
              if (!rowsById.has(row.id)) rowsById.set(row.id, row);
              vectorDistanceById.set(row.id, hit.distance);
            }
          }
        } else {
          const knnHits = knn(db, space, queryVector, { k: candidateLimit, scope });
          const loaded = loadRowsBySeq(
            db,
            knnHits.map((hit) => hit.memorySeq),
          );
          for (const hit of knnHits) {
            if (hit.distance > maxVectorDistance) continue;
            const row = loaded.get(hit.memorySeq);
            if (!row) continue; // soft-deleted/superseded since indexing: never surfaces (§10)
            vectorIds.push(row.id);
            if (!rowsById.has(row.id)) rowsById.set(row.id, row);
            vectorDistanceById.set(row.id, hit.distance);
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
  // upper bound, so this needs SOME normalisation. Dividing by the top score
  // alone (the previous approach) is the wrong normalisation FOR THE BLEND:
  // in a single-branch (FTS-only, the default zero-config mode) result set,
  // the fused score at rank r is exactly `1/(RRF_K+r)`, so `score/maxScore`
  // is `(RRF_K+1)/(RRF_K+r)` — a curve that only spans down to ~0.55 by rank
  // 10, compressing the WHOLE top-10 relevance spread into less than the
  // recency term's own span (rerank.ts's `w.recency` term alone covers a
  // full week's exponential decay). That compression is what let a
  // several-ranks-worse, barely-relevant FTS hit outscore a clearly better,
  // slightly-older one on the blended score (a reproduced defect, see
  // search.test.ts). Min-max normalising against BOTH ends of this call's
  // own fused set restores the full 0..1 range regardless of branch count or
  // fused-list size for THAT job — the best candidate is exactly 1, the
  // worst is exactly 0, and everything else falls proportionally between
  // them, so a rank-position difference is never silently worth less than it
  // should be relative to the other blend terms.
  //
  // But min-max pins the single WORST fused candidate to exactly 0 for every
  // N by construction — that is fine as a blend input (0 just means "least
  // relevant of this particular set", still ranked correctly relative to its
  // peers), but it is wrong as a THRESHOLD input: `minRelevance` is supposed
  // to mean "this candidate's own match quality is too weak to bother with",
  // not "this happened to be the worst of however many candidates fused this
  // call" — the latter deletes the worst survivor of every non-empty result
  // set regardless of how good it actually is (five equally strong matches
  // -> four returned; two matches -> one). So thresholding and blending are
  // two different jobs and must not share one normalisation: `minRelevance`
  // is applied below against the max-only scale (`item.score / maxScore`,
  // the same curve described above) via `preNormRelevanceById`, which still
  // maps the single best candidate to 1 and never manufactures an artificial
  // 0 — only a candidate that is genuinely far behind the leader on raw RRF
  // score reads as low on this scale. `relevanceById` (min-max) remains what
  // rerank() blends. fused is sorted score-desc, so fused[0]/fused[fused.
  // length-1] are the max/min directly; the degenerate case (every fused
  // score identical, including the single-candidate case) has no meaningful
  // range to spread across, so it maps every candidate to 1 rather than
  // dividing by zero.
  const maxScore = fused[0]!.score;
  const minScore = fused[fused.length - 1]!.score;
  const scoreRange = maxScore - minScore;
  const relevanceById = new Map(
    fused.map((item) => [item.id, scoreRange > 0 ? (item.score - minScore) / scoreRange : 1]),
  );
  const preNormRelevanceById = new Map(fused.map((item) => [item.id, maxScore > 0 ? item.score / maxScore : 1]));

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
  // never empty it on its own). Applied against `preNormRelevanceById`
  // (max-only scale), NOT the min-max-normalised `relevance` rerank() just
  // blended with — see the long comment above `relevanceById` for why those
  // must be two different scales. Applied after re-rank has had its say but
  // before MMR spends any work diversifying a set that is mostly noise.
  const minRelevance = clampMinRelevance(options.minRelevance);
  const reranked = rerank(rerankInput, now, options.weights)
    .filter((r) => (preNormRelevanceById.get(r.id) ?? 0) >= minRelevance)
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

  const provenanceById = fetchProvenanceByIds(db, selectedIds);

  const rerankedById = new Map(reranked.map((r) => [r.id, r]));
  const hits: SearchHit[] = selectedIds.map((id) => {
    const r = rerankedById.get(id)!;
    const row = rowsById.get(id)!;
    const ranks = ranksById.get(id) ?? [null, null];
    const provenance = provenanceById.get(id);
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
      vectorDistance: vectorDistanceById.get(id) ?? null,
      origin: provenance?.origin,
      approved: provenance?.approved,
    };
  });

  return { hits, degraded, degradedReason };
}
