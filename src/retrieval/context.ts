// The BUILD_BRIEF §8 budgeted context block — what `get_context` returns.
// The budget is the entire point: §8/§14 record "context pollution" (a
// well-known project dumping its whole memory store into context and
// having to retreat to a small index) as a documented, named failure. This
// module must never hand back more than the caller's token budget, no
// matter how big the store is.

import type { CairnDb } from "../storage/db.js";
import type { SqlValue } from "../storage/driver/index.js";
import { num, numOrNull, str } from "../storage/repositories/row.js";
import { listMemories } from "../storage/repositories/memories.js";
import { rerank } from "./rerank.js";
import type { RerankItem } from "./rerank.js";
import { search, fetchTagsByIds } from "./search.js";
import type { SearchDeps, SearchHit, SearchOptions, SearchResult } from "./search.js";

export interface ContextOptions extends SearchOptions {
  tokenBudget?: number;
}

export interface ContextBlock {
  text: string;
  memories: SearchHit[];
  tokensEstimated: number;
  truncated: boolean;
  degraded: boolean;
  degradedReason: string | null;
}

const DEFAULT_TOKEN_BUDGET = 800;

function clampTokenBudget(budget: number | undefined): number {
  if (budget === undefined || !Number.isFinite(budget) || budget < 1) return DEFAULT_TOKEN_BUDGET;
  return Math.floor(budget);
}

// `search()`'s own limit defaults to 10 (clamped to 50) because a raw
// recall call rarely wants more. get_context is different: the TOKEN BUDGET
// is what should decide how many memories make the cut, not an artificially
// small candidate count, so this always asks search() for its hard ceiling
// unless the caller overrides `limit` explicitly.
const MAX_CONTEXT_CANDIDATES = 50;

// search()'s own candidateLimit defaults to 50 too — the same value as
// MAX_CONTEXT_CANDIDATES above. Left alone, that makes `limit ===
// candidateLimit`: RRF gets no wider pool to fuse within than it returns,
// and MMR selects every candidate it is handed instead of choosing among
// them, so diversity re-ranking becomes a no-op. get_context always widens
// the candidate pool past its own result limit so both stages have
// something to actually rank.
const CONTEXT_CANDIDATE_LIMIT = 200;

// The pool size used for EACH of the two bounded queries the empty-query
// (recency+importance) fallback below unions together (see
// emptyQueryFallback). Matches the storage layer's own page-size ceiling
// (paging.ts MAX_PAGE_LIMIT) — this is a bounded "what matters right now"
// index, not an exhaustive scan; the merged pool is at most 2x this, never
// unbounded.
const EMPTY_QUERY_POOL_LIMIT = 200;

// `search()`'s own SearchOptions.minRelevance defaults to
// search.ts's DEFAULT_MIN_RELEVANCE (0.1): a floor sized for `recall`, a
// deliberate act — the user asked, so a weak-but-possibly-useful hit only
// costs them a glance. `get_context` is injected automatically at session
// start (BUILD_BRIEF §8), unrequested by the user for this particular
// turn; a weak hit there is not a glance, it is unasked content silently
// occupying a token budget the user never agreed to spend. BUILD_BRIEF §14
// names exactly that pattern — a well-known project having to retreat from
// dumping loosely-related memories into context — as the documented
// failure this whole budgeted-block design exists to avoid. So this floor
// is deliberately STRICTER than search()'s default; the asymmetry is the
// point, not an oversight.
//
// IMPORTANT caveat this constant alone cannot fix: minRelevance is
// RELATIVE to this call's own top fused score (see search.ts), so the
// single best-ranked candidate in any non-empty result always clears it,
// no matter how high it is set — raising this constant SHRINKS a weak
// result set, it can never EMPTY one. DEFAULT_CONTEXT_MIN_COVERAGE below
// is the floor that actually can, because term coverage is absolute, not
// rank-relative.
//
// Like search()'s own default, this is a starting point that needs tuning
// against real transcripts, not a tuned result (§14 forbids presenting
// self-run numbers as established fact) — exported so it stays greppable
// and directly testable rather than a bare literal.
export const DEFAULT_CONTEXT_MIN_RELEVANCE = 0.15;

// search()'s own SearchOptions.minCoverage defaults to
// search.ts's DEFAULT_MIN_COVERAGE (0.2, permissive) because `recall` is an
// explicit, deliberate query. `get_context` needs the stricter value for
// the same asymmetry argument as DEFAULT_CONTEXT_MIN_RELEVANCE above — and
// unlike that floor, this one is genuinely absolute (not normalised
// against this call's own top score) for an FTS-branch hit, so it is what
// actually lets `get_context` reject a result set where even the
// single best-ranked candidate is a bare incidental word-overlap (e.g. a
// pet-themed memory store returning its one memory that happens to contain
// the word "deployment" for the query "kubernetes deployment rollback
// procedure" — one term out of four). Its denominator is capped
// (see fts.ts's `COVERAGE_DENOMINATOR_CAP`) so this floor stays reachable
// for a long natural-language question instead of silently requiring
// every content word in it to match. A vector-branch hit has no coverage
// signal at all and is EXEMPT from this floor (see search.ts's
// SearchOptions.minCoverage) — search.ts's `maxVectorDistance` is that
// branch's own, independent absolute floor, and `get_context` uses a
// stricter default for it than `recall` for the same reason as this
// constant (see `DEFAULT_CONTEXT_MAX_VECTOR_DISTANCE` below). Starting-point
// default, NOT a tuned result (§14): needs tuning against real transcripts
// like every other floor here.
export const DEFAULT_CONTEXT_MIN_COVERAGE = 0.4;

// search()'s own SearchOptions.maxVectorDistance defaults to
// search.ts's DEFAULT_MAX_VECTOR_DISTANCE, sized for `recall`. The vector
// branch is exempt from DEFAULT_CONTEXT_MIN_COVERAGE above (a semantic
// match's words legitimately differ from the query's), so THIS is that
// branch's own absolute floor for `get_context` — without it, a store with
// no memory genuinely related to the query still returns its k nearest
// (however distant) neighbours, and BUILD_BRIEF §14's context pollution
// happens in semantic mode instead of keyword mode. Stricter (a smaller
// distance ceiling) than `recall`'s default for the same unrequested-
// injection asymmetry as every other floor in this file.
export const DEFAULT_CONTEXT_MAX_VECTOR_DISTANCE = 0.15;

/**
 * A script-aware approximation of token count: `ceil(utf8ByteLength(text) /
 * 3)`. Pulling in a real tokenizer would contradict the zero-dependency,
 * zero-download start BUILD_BRIEF §2 requires, and `chars / 4` — the usual
 * rule of thumb — turns out to silently UNDER-count by 2-3x on exactly the
 * content a developer's memory store fills with: CJK text (each character
 * is close to one token but three UTF-8 bytes), emoji/ZWJ sequences
 * (several 4-byte codepoints per visual glyph), and base64 (dense ASCII
 * that tokenizes far above one token per four characters). UTF-8 byte
 * length already carries that density without a tokenizer: CJK runs ~3
 * bytes/char, so bytes/3 lands close to 1 token/char; emoji and base64
 * push the byte count higher still, so dividing by 3 stays conservative
 * (over-, not under-, counting) there too; and for plain ASCII, bytes/3 is
 * comfortably above the ~4-chars-per-token English rule of thumb.
 *
 * The guarantee this actually provides: it tracks real tokenizer output
 * closely enough — and biases upward often enough across scripts — to be a
 * safe gate for a token BUDGET. It is not a mathematical proof that no
 * input can ever under-count; there is no such proof without the real
 * tokenizer this function deliberately avoids.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

// A line beginning with this shape is what formatEntry below emits as a
// real entry marker. Untrusted memory text (no ingest redaction yet, and
// BUILD_BRIEF §1 promises importers pulling in raw Claude/ChatGPT exports)
// must never be able to reproduce it, or a newline embedded in one memory's
// text can forge a second entry with a fabricated id/scope/date that is
// indistinguishable from a real one to the model reading this block.
const ENTRY_MARKER = /^-(\s*\[)/;

// Newlines inside memory text are legitimate — the episodic log keeps raw
// content verbatim — so they cannot be rejected at write time. They ARE
// rejected here, at render time: every real/reserved line-break character
// collapses to a single space, which alone prevents a forged entry from
// starting its own line. The leading-marker neutralisation below is
// defence in depth on top of that, in case this text is ever concatenated
// or line-split some other way upstream.
function sanitizeEntryText(text: string): string {
  const collapsed = text.replace(/[\r\n\u2028\u2029]+/g, " ");
  return collapsed.replace(ENTRY_MARKER, (_match, bracket: string) => `\u2010${bracket}`);
}

// Compact, greppable provenance per BUILD_BRIEF §6: id, scope, and creation
// date. A context block the model cannot attribute is a block the user
// cannot audit.
function formatEntry(hit: SearchHit): string {
  const date = new Date(hit.createdAt).toISOString().slice(0, 10);
  return `- [${hit.id} | ${hit.scope} | ${date}] ${sanitizeEntryText(hit.text)}`;
}

function tieBreak(aId: string, aScore: number, bId: string, bScore: number): number {
  if (bScore !== aScore) return bScore - aScore;
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

// The subset of Memory's fields emptyQueryFallback actually needs. Both the
// recency pool (listMemories, a Memory[]) and the importance pool below
// (a raw query against memories_live) are read structurally against this,
// so neither needs to construct a full Memory.
interface PoolMemory {
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

// The importance-ordered half of the empty-query pool (see
// emptyQueryFallback below). Queries memories_live directly, the same
// sanctioned view fts.ts and search.ts read through, rather than
// listMemories — listMemories only orders by (created_at, id) for its
// keyset pagination and has no importance-ordered mode. Bounded by `limit`
// in SQL, same as the recency half; never an unbounded scan.
function loadImportancePool(db: CairnDb, scope: string | undefined, limit: number): PoolMemory[] {
  const conditions: string[] = [];
  const params: SqlValue[] = [];
  if (scope !== undefined) {
    conditions.push("scope = ?");
    params.push(scope);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .q(
      `SELECT seq, id, text, scope, importance, created_at, last_accessed, access_count
       FROM memories_live
       ${where}
       ORDER BY importance DESC, created_at DESC
       LIMIT ?`,
    )
    .all(...params, limit);
  const ids = rows.map((row) => str(row, "id"));
  const tagsById = fetchTagsByIds(db, ids);
  return rows.map((row) => {
    const id = str(row, "id");
    return {
      id,
      seq: num(row, "seq"),
      text: str(row, "text"),
      scope: str(row, "scope"),
      tags: tagsById.get(id) ?? [],
      importance: num(row, "importance"),
      createdAt: num(row, "created_at"),
      lastAccessed: numOrNull(row, "last_accessed"),
      accessCount: num(row, "access_count"),
    };
  });
}

// An empty (or whitespace-only) query is a first-class case, not an error:
// it is what a session-start hook sends when it wants a budgeted index of
// "what matters" rather than an answer to a specific question. There is no
// question to be relevant to, so this runs no FTS and no vector branch at
// all — it ranks the scope by recency and importance only (relevance
// pinned to 0 for every candidate) and is therefore never "degraded": it is
// a different, fully intended mode, not a fallback from a failure.
//
// The pool is the UNION of two independently bounded queries — the newest
// EMPTY_QUERY_POOL_LIMIT by created_at DESC, and the top
// EMPTY_QUERY_POOL_LIMIT by importance DESC, created_at DESC — deduped by
// id, not just the recency query alone. A recency-only pool means
// importance can only ever re-rank INSIDE the newest N memories: a single
// very old but critically important memory (e.g. an allergy noted 400 days
// ago) can never surface at all, no matter how high its importance weight
// is set, because it never gets a seat in the pool to be re-ranked within.
// Unioning in a second, importance-ordered query gives it that seat while
// keeping both queries bounded — this is still a "what matters right now"
// index, not an exhaustive scan of the store.
function emptyQueryFallback(db: CairnDb, options: ContextOptions & { limit: number }, now: number): SearchResult {
  const recencyPool = listMemories(db, { scope: options.scope, limit: EMPTY_QUERY_POOL_LIMIT }).items;
  const importancePool = loadImportancePool(db, options.scope, EMPTY_QUERY_POOL_LIMIT);
  const mergedById = new Map<string, PoolMemory>();
  for (const memory of recencyPool) mergedById.set(memory.id, memory);
  for (const memory of importancePool) {
    if (!mergedById.has(memory.id)) mergedById.set(memory.id, memory);
  }
  const pool = Array.from(mergedById.values());
  const tags = options.tags ?? [];
  const filtered = tags.length > 0 ? pool.filter((memory) => tags.every((tag) => memory.tags.includes(tag))) : pool;

  const items: RerankItem[] = filtered.map((memory) => ({
    id: memory.id,
    relevance: 0,
    createdAt: memory.createdAt,
    importance: memory.importance,
    lastAccessed: memory.lastAccessed,
    accessCount: memory.accessCount,
  }));
  const reranked = rerank(items, now, options.weights).sort((a, b) => tieBreak(a.id, a.score, b.id, b.score));
  const top = reranked.slice(0, options.limit);

  const byId = new Map(filtered.map((memory) => [memory.id, memory]));
  const hits: SearchHit[] = top.map((r) => {
    const memory = byId.get(r.id)!;
    return {
      id: memory.id,
      seq: memory.seq,
      text: memory.text,
      scope: memory.scope,
      tags: memory.tags,
      importance: memory.importance,
      createdAt: memory.createdAt,
      lastAccessed: memory.lastAccessed,
      accessCount: memory.accessCount,
      score: r.score,
      parts: r.parts,
      sources: { fts: null, vector: null },
      coverage: null,
      vectorDistance: null,
    };
  });

  return { hits, degraded: false, degradedReason: null };
}

/**
 * The BUILD_BRIEF §8 budgeted context block. Fills greedily in ranked
 * order; every accept is gated on `estimateTokens` of the candidate text
 * staying within `tokenBudget` (default 800), so `tokensEstimated`
 * (computed the same way from the final text) can never exceed
 * `tokenBudget` — that is a hard invariant of this loop, not a
 * best-effort target.
 *
 * An oversized entry that would blow the budget is SKIPPED, not treated
 * as a stopping point: the loop keeps trying lower-ranked candidates
 * after it. The returned memories are therefore a ranked SUBSET, not
 * necessarily a ranked prefix — BUILD_BRIEF §8 asks for a budgeted index
 * of what matters, and does not require the block to stop dead the
 * instant one candidate doesn't fit. A budgeted block that skips one
 * oversized memory and keeps five short relevant ones is strictly better
 * than an empty block, which is what a single 4000-character memory at
 * rank 1 used to produce.
 *
 * A single memory longer than the entire budget is OMITTED, not
 * truncated mid-text: this function never returns a partial memory, only
 * whole ones. `truncated` is still set to true in that case, since there
 * was more the caller asked for than made it into the block.
 *
 * Never throws for an empty store: with no candidates, the loop below
 * simply never runs, and the result is an empty, non-truncated block.
 */
export async function getContext(
  db: CairnDb,
  query: string,
  options: ContextOptions = {},
  deps: SearchDeps = {},
): Promise<ContextBlock> {
  const now = options.now ?? Date.now();
  const tokenBudget = clampTokenBudget(options.tokenBudget);
  const trimmed = query.trim();
  const searchLimit = options.limit ?? MAX_CONTEXT_CANDIDATES;

  const result: SearchResult =
    trimmed.length === 0
      ? emptyQueryFallback(db, { ...options, limit: searchLimit }, now)
      : await search(
          db,
          query,
          // A session-start block must never quietly inject weakly-related
          // memories the user never asked for (BUILD_BRIEF §14 context
          // pollution) — see DEFAULT_CONTEXT_MIN_RELEVANCE,
          // DEFAULT_CONTEXT_MIN_COVERAGE and DEFAULT_CONTEXT_MAX_VECTOR_DISTANCE
          // above for why all three floors are stricter than search()'s own
          // defaults, and why coverage/maxVectorDistance are the ones that
          // can actually empty a result set (one per branch).
          {
            ...options,
            limit: searchLimit,
            candidateLimit: options.candidateLimit ?? CONTEXT_CANDIDATE_LIMIT,
            minRelevance: options.minRelevance ?? DEFAULT_CONTEXT_MIN_RELEVANCE,
            minCoverage: options.minCoverage ?? DEFAULT_CONTEXT_MIN_COVERAGE,
            maxVectorDistance: options.maxVectorDistance ?? DEFAULT_CONTEXT_MAX_VECTOR_DISTANCE,
          },
          deps,
        );

  let text = "";
  const memories: SearchHit[] = [];
  let truncated = false;

  for (const hit of result.hits) {
    const entry = formatEntry(hit);
    const candidate = text.length === 0 ? entry : `${text}\n${entry}`;
    if (estimateTokens(candidate) > tokenBudget) {
      truncated = true;
      continue; // skip this oversized entry, keep trying lower-ranked ones
    }
    text = candidate;
    memories.push(hit);
  }

  return {
    text,
    memories,
    tokensEstimated: estimateTokens(text),
    truncated,
    degraded: result.degraded,
    degradedReason: result.degradedReason,
  };
}
