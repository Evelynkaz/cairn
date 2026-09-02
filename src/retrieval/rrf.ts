export const RRF_K = 10;

export interface FusedItem {
  id: string;
  score: number;
  ranks: (number | null)[];
}

/**
 * Reciprocal Rank Fusion (BUILD_BRIEF §7): combines the vector-KNN ranking
 * and the FTS5 BM25 ranking into one ordering.
 *
 * Why RRF at all: BM25 scores and cosine-distance scores live on
 * incomparable scales (unbounded term-frequency weighting vs. a bounded
 * distance metric), so combining them with a weighted sum would first
 * require normalising both against each other — and there is no
 * principled way to do that (per query? per corpus? which distribution?).
 * RRF sidesteps the problem entirely: it only looks at each list's RANK
 * ordering, never its raw scores, so no normalisation is ever needed.
 *
 * `score(id) = sum over lists containing id of 1 / (k + rank)`, rank
 * starting at 1 for the best item in each list. A list that does not
 * contain the id contributes nothing to its score (and `null` to its
 * `ranks` entry). `k` defaults to `RRF_K` (§3: k≈10); a duplicate id
 * within a single list only counts its first (best) occurrence.
 */
export function rrfFuse(lists: readonly (readonly string[])[], k: number = RRF_K): FusedItem[] {
  const scores = new Map<string, number>();
  const ranks = new Map<string, (number | null)[]>();
  const bestRanks = new Map<string, number>();

  for (let listIndex = 0; listIndex < lists.length; listIndex++) {
    const list = lists[listIndex]!;
    const seen = new Set<string>();
    let rank = 0;

    for (const id of list) {
      if (seen.has(id)) continue; // duplicate within a list: first (best) occurrence wins
      seen.add(id);
      rank += 1;

      if (!scores.has(id)) {
        scores.set(id, 0);
        ranks.set(id, new Array(lists.length).fill(null));
      }
      ranks.get(id)![listIndex] = rank;
      scores.set(id, scores.get(id)! + 1 / (k + rank));

      const prevBest = bestRanks.get(id);
      if (prevBest === undefined || rank < prevBest) {
        bestRanks.set(id, rank);
      }
    }
  }

  const items: FusedItem[] = Array.from(scores.keys(), (id) => ({
    id,
    score: scores.get(id)!,
    ranks: ranks.get(id)!,
  }));

  // Deterministic tie-break: score desc, then best (lowest) rank achieved
  // in any list, then lexicographic id. This must not depend on the
  // iteration order of the Maps above (itself just insertion order of the
  // input lists) — callers can assemble the same set of ranked lists in
  // different orders across otherwise-identical queries, and a tie-break
  // that leaked that order would make results wobble between runs, which
  // is maddening to debug.
  items.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const rankDiff = bestRanks.get(a.id)! - bestRanks.get(b.id)!;
    if (rankDiff !== 0) return rankDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return items;
}
