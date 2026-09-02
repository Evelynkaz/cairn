// FTS5 full-text search over live memories. Query escaping is the whole
// point of this module: user text goes straight into MATCH, and FTS5 has
// its own syntax (":" is a column filter, `"` opens a phrase, `*` is a
// prefix, `^` anchors, AND/OR/NOT/NEAR are operators). An ordinary
// question like "what did I say about foo:bar?" must never raise
// "fts5: syntax error", so every raw query is escaped into terms before it
// reaches MATCH.

import type { CairnDb } from "../storage/db.js";
import type { SqlValue } from "../storage/driver/index.js";
import { num, numOrNull, str } from "../storage/repositories/row.js";
import { clampLimit } from "../storage/repositories/paging.js";

export interface FtsHit {
  seq: number;
  id: string;
  text: string;
  scope: string;
  tags: string[];
  importance: number;
  createdAt: number;
  lastAccessed: number | null;
  accessCount: number;
  bm25: number;
  /** Fraction (0..1) of the query's content terms (see `contentTerms`)
      this hit's text actually contains, matched case- and
      diacritic-insensitively so it agrees with the `remove_diacritics 2`
      FTS5 tokenizer (see migrations/001-init.ts). This is the
      corpus-independent complement to `bm25`: a rank/score says how this
      hit compares to OTHERS in the same result set, coverage says how
      much of the QUESTION it actually answers. */
  coverage: number;
}

export interface FtsOptions {
  scope?: string;
  tags?: string[];
  limit?: number;
  /** Relative bm25 floor within this call's own result set — see
      `DEFAULT_MIN_BM25_RATIO`. */
  minBm25Ratio?: number;
}

// A token run is letters/digits, with an intra-word apostrophe or hyphen
// tolerated so "don't" and "co-op" stay one token; everything else
// (":", '"', "*", whitespace, ...) is just a separator, never rejected.
const TOKEN_RE = /[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu;

// Caps the number of terms a single query can expand to, so a pathological
// (e.g. very long) input cannot build an unbounded MATCH expression.
const MAX_TOKENS = 32;

// A short, conservative English function-word list (articles, common
// prepositions, auxiliaries, pronouns). Dropped from the query BEFORE it is
// turned into an OR-joined MATCH expression, because OR semantics (see
// `toMatchQuery` below) mean any memory sharing even one of these with the
// query — which is nearly every memory, for words this common — matches
// with a false sense of relevance (the BUILD_BRIEF §14 "context pollution"
// failure: a query with no real subject in common with the store still
// returns confident-looking hits on "the"/"is"/"a" alone). Exported so a
// test can pin the exact set.
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the",
  "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did",
  "have", "has", "had",
  "will", "would", "can", "could", "shall", "should", "may", "might", "must",
  "in", "on", "at", "to", "of", "for", "with", "by", "from", "about", "as",
  "and", "or", "but", "not",
  "i", "you", "he", "she", "it", "we", "they",
  "this", "that", "these", "those",
  "what", "which", "who", "whom", "whose",
  "my", "your", "his", "her", "its", "our", "their",
]);

// The content-bearing (non-stopword) terms a query reduces to, capped at
// MAX_TOKENS, in original casing and source order. `toMatchQuery` below
// builds its MATCH expression from exactly this list — never a separately
// re-derived one — so the terms a coverage check (see `hitCoverage`) tests
// against can never drift from the terms that actually reached FTS5.
export function contentTerms(raw: string): string[] {
  const tokens = raw.match(TOKEN_RE);
  if (!tokens || tokens.length === 0) return [];
  const contentTokens = tokens.filter((token) => !STOPWORDS.has(token.toLowerCase()));
  return contentTokens.slice(0, MAX_TOKENS);
}

// Turns arbitrary user text into a MATCH expression that FTS5 can never
// reject as a syntax error and that never lets user input act as an
// operator: every token is quoted as a literal term (doubling any embedded
// `"`), so a bare word that happens to spell AND/OR/NOT/NEAR is searched
// for as that word, not interpreted as the operator. Tokens are joined
// with OR rather than AND: AND would make a five-word natural-language
// question return nothing the moment any single word is missing from the
// target memory, which is the common case, not the exception — BM25
// ranking is what then sorts relevant from marginal OR-matches.
//
// Stopwords are dropped before quoting: an OR query built from function
// words alone matches almost any memory (see STOPWORDS above), so a query
// that is ENTIRELY stopwords is content-free and must behave exactly like
// an empty query. Returns null when nothing content-bearing survives
// (empty, punctuation-only, or stopword-only input); callers must treat
// null as "no FTS results", never as an error or as "match everything".
export function toMatchQuery(raw: string): string | null {
  const terms = contentTerms(raw);
  if (terms.length === 0) return null;
  const quoted = terms.map((token) => `"${token.replace(/"/g, '""')}"`);
  return quoted.join(" OR ");
}

// Folds a string the same way `remove_diacritics 2` + unicode61's
// case-folding does, close enough for a filter (not a ranker): NFD
// decomposes accented letters into base letter + combining marks, which
// the regex then strips, and toLowerCase() handles case. Used only to
// compare a query term against a memory's own text for `hitCoverage` —
// never sent to FTS5, which already does its own folding.
function foldForCoverage(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// What fraction of `terms` (a query's content terms) appear as whole
// tokens in `text`, folded per `foldForCoverage`. Tokenizing `text` with
// the same TOKEN_RE the query itself was split on is what makes this
// "word boundaries", not a raw substring test — "cat" must not count
// "category" as coverage. An empty `terms` list has nothing to check
// coverage against, so it reports full (1) coverage rather than 0, which
// would wrongly zero out every hit for a query with no content terms at
// all (a case `ftsSearch` never actually reaches, since `toMatchQuery`
// already returns null and short-circuits before any row is scored).
function hitCoverage(terms: string[], text: string): number {
  if (terms.length === 0) return 1;
  const textTokens = text.match(TOKEN_RE);
  const textTermSet = new Set((textTokens ?? []).map(foldForCoverage));
  const present = terms.filter((term) => textTermSet.has(foldForCoverage(term)));
  return present.length / terms.length;
}

// Starting-point ratio, NOT a tuned result (§14 warns against presenting
// self-run numbers as fact) — needs tuning against real transcripts. A hit
// surviving this floor must retain at least this fraction of the best
// hit's bm25 MAGNITUDE (see the sign comment in ftsSearch below), which
// cuts pure noise (a hit that only shares a rare, weakly-weighted term)
// while letting a genuinely weaker-but-real match through.
export const DEFAULT_MIN_BM25_RATIO = 0.1;

function fetchTagsBySeq(db: CairnDb, seqs: number[]): Map<number, string[]> {
  const result = new Map<number, string[]>();
  if (seqs.length === 0) return result;
  const placeholders = seqs.map(() => "?").join(", ");
  const rows = db
    .q(
      `SELECT m.seq AS seq, mt.tag AS tag
       FROM memory_tags mt
       JOIN memories m ON m.id = mt.memory_id
       WHERE m.seq IN (${placeholders})
       ORDER BY mt.tag`,
    )
    .all(...seqs);
  for (const row of rows) {
    const seq = num(row, "seq");
    const list = result.get(seq);
    if (list) {
      list.push(str(row, "tag"));
    } else {
      result.set(seq, [str(row, "tag")]);
    }
  }
  return result;
}

// Sanctioned way to search: joins memories_fts to memories_live (never the
// bare memories table), because soft-deleted and superseded rows
// deliberately remain in the FTS index (see migrations/001-init.ts) and
// the view is the schema's guard against a forgotten liveness filter — the
// failure mode is a deleted or stale memory resurfacing in recall, a §10
// privacy break, not just a wrong row.
export function ftsSearch(db: CairnDb, query: string, options: FtsOptions = {}): FtsHit[] {
  const terms = contentTerms(query);
  const matchQuery = toMatchQuery(query);
  if (matchQuery === null) return [];

  const limit = clampLimit(options.limit);
  const conditions: string[] = ["memories_fts MATCH ?"];
  const params: SqlValue[] = [matchQuery];

  if (options.scope !== undefined) {
    conditions.push("m.scope = ?");
    params.push(options.scope);
  }
  // AND semantics, same pattern as listMemories: one EXISTS clause per
  // requested tag, one placeholder per tag, never interpolation.
  for (const tag of options.tags ?? []) {
    conditions.push(`EXISTS (SELECT 1 FROM memory_tags mt WHERE mt.memory_id = m.id AND mt.tag = ?)`);
    params.push(tag);
  }

  const rows = db
    .q(
      `SELECT m.seq AS seq, m.id AS id, m.text AS text, m.scope AS scope,
              m.importance AS importance, m.created_at AS created_at,
              m.last_accessed AS last_accessed, m.access_count AS access_count,
              bm25(memories_fts) AS bm25
       FROM memories_fts f
       JOIN memories_live m ON m.seq = f.rowid
       WHERE ${conditions.join(" AND ")}
       -- bm25() returns NEGATIVE values, more negative = better match, so
       -- ascending order is best-match-first. This is the classic mistake:
       -- ORDER BY bm25(...) DESC would put the worst matches on top.
       ORDER BY bm25(memories_fts) ASC
       LIMIT ?`,
    )
    .all(...params, limit);

  if (rows.length === 0) return [];

  // Relative floor: rows are already ORDER BY bm25 ASC, so rows[0] is the
  // best (most negative) score in this result set. bm25() is NEGATIVE and
  // MORE NEGATIVE means a BETTER match — the classic mistake here is
  // treating a bm25 "floor" as a lower bound the way it would be for a
  // normal positive score, which is backwards: multiplying a negative
  // number by a fraction in (0, 1) moves it TOWARD zero, i.e. makes it
  // WORSE, so `bestBm25 * ratio` is the correct weaker-but-still-acceptable
  // threshold, and a hit survives only while its own bm25 stays AT OR
  // BELOW (at least as negative as) that threshold.
  const bestBm25 = num(rows[0]!, "bm25");
  const ratio = options.minBm25Ratio ?? DEFAULT_MIN_BM25_RATIO;
  const floor = bestBm25 * ratio;
  const survivors = rows.filter((row) => num(row, "bm25") <= floor);

  const seqs = survivors.map((row) => num(row, "seq"));
  const tagsBySeq = fetchTagsBySeq(db, seqs);

  return survivors.map((row) => {
    const seq = num(row, "seq");
    return {
      seq,
      id: str(row, "id"),
      text: str(row, "text"),
      scope: str(row, "scope"),
      tags: tagsBySeq.get(seq) ?? [],
      importance: num(row, "importance"),
      createdAt: num(row, "created_at"),
      lastAccessed: numOrNull(row, "last_accessed"),
      accessCount: num(row, "access_count"),
      bm25: num(row, "bm25"),
      coverage: hitCoverage(terms, str(row, "text")),
    };
  });
}
