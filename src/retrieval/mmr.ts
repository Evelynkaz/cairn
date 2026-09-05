export interface MmrCandidate {
  id: string;
  relevance: number;
  vector: Float32Array | null;
}

/**
 * True cosine similarity — does not assume L2-normalised input. Embeddings
 * from the local ONNX/model2vec providers are expected to already be
 * normalised (§3), but a caller-side violation of that invariant should
 * not silently corrupt every downstream MMR ranking, so the norm is always
 * computed.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch (${a.length} vs ${b.length})`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const DEFAULT_LAMBDA = 0.7;

// `lambda` is not reachable from the MCP or dashboard surface today
// (SearchOptions.mmrLambda has no caller that forwards an untrusted value),
// but it IS a public function parameter, so a future caller (or a bad
// default threaded through config) must not be able to corrupt every
// ranking. `NaN` would otherwise make every `mmrScore` comparison false,
// leaving `bestIndex` at its initial -1 and throwing when `remaining[-1]` is
// used; a value outside [0, 1] (e.g. -1) would invert the relevance/
// diversity trade-off instead of just mis-weighting it. Clamped to the
// nearest valid endpoint, same pattern as clampMinRelevance/clampMinCoverage
// in search.ts.
function clampLambda(lambda: number): number {
  if (!Number.isFinite(lambda)) return DEFAULT_LAMBDA;
  if (lambda < 0) return 0;
  if (lambda > 1) return 1;
  return lambda;
}

/**
 * Maximal Marginal Relevance (BUILD_BRIEF §7): greedily picks the
 * candidate maximising `lambda*relevance - (1-lambda)*maxSimilarityToAlreadySelected`,
 * trading pure relevance ranking for diversity in the top-K.
 *
 * Similarity is floored at 0 (`Math.max(0, cosineSimilarity(...))`) before
 * it is used as a diversity penalty: `cosineSimilarity` can legitimately
 * return a negative value for a genuinely anti-correlated pair, and an
 * un-floored negative "penalty" flips sign in `-(1-lambda)*maxSim` and
 * becomes a BONUS — an anti-correlated candidate would rank ABOVE an
 * unrelated (near-zero similarity) one for being diverse, which is not what
 * MMR is supposed to reward; diversity should never be worth MORE than
 * "no measurable similarity at all".
 *
 * A `null` vector (memory not yet embedded, or the store running in
 * FTS-only mode per §2 with no embedding model at all) cannot contribute a
 * REAL similarity to anything, and is scored at a flat 0 against every
 * other candidate. Tried the alternative (estimating a null pairing from
 * the mean of real-vs-real similarities observed elsewhere in the same
 * call) and rejected it: with few real-vector candidates in play, that mean
 * is easily dominated by a single outlier pair (e.g. one genuinely
 * near-duplicate real candidate), which can swing the WRONG way and
 * penalise a null candidate MORE harshly than an actual near-duplicate is
 * penalised — worse than the flat-0 baseline it was meant to improve on,
 * and not worth the added complexity for a case that is not reachable from
 * the MCP or dashboard surface today.
 *
 * This flat 0 is EXPLICITLY NOT NEUTRAL once real embeddings are in the
 * mix, and this comment says so plainly rather than implying otherwise:
 * two genuinely UNRELATED real vectors from the local embedding models this
 * project ships already sit around 0.6-0.75 cosine similarity (anisotropy),
 * so 0 is actually the LOWEST possible similarity a pairing can have. An
 * un-embedded candidate is therefore FAVOURED for diversity purposes over
 * an embedded one of equal or higher relevance, purely for lacking a
 * vector — after a provider outage, a backlog of un-embedded memories can
 * out-rank better-embedded ones of equal relevance. It is never unfairly
 * DROPPED (it still competes on its relevance term, and a null-vs-null
 * pairing is correctly neutral), which is why this is a documented bias,
 * not a broken filter. If every candidate's vector is null for the whole
 * call, every similarity term stays 0 throughout and MMR degrades exactly
 * to plain relevance ranking, so FTS-only mode never produces a broken or
 * empty result.
 */
export function mmr(candidates: readonly MmrCandidate[], k: number, lambda: number = DEFAULT_LAMBDA): string[] {
  if (k <= 0) return [];

  const safeLambda = clampLambda(lambda);
  const remaining = candidates.slice();
  const selected: MmrCandidate[] = [];
  const limit = Math.min(k, candidates.length);

  while (selected.length < limit) {
    let bestIndex = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      let maxSim = 0;

      for (const sel of selected) {
        if (candidate.vector === null || sel.vector === null) continue; // missing vector => similarity 0, see above
        const sim = Math.max(0, cosineSimilarity(candidate.vector, sel.vector));
        if (sim > maxSim) maxSim = sim;
      }

      const mmrScore = safeLambda * candidate.relevance - (1 - safeLambda) * maxSim;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = i;
      }
    }

    // remaining is non-empty on every iteration: the loop guard keeps
    // selected.length below limit, which is capped at candidates.length.
    selected.push(remaining[bestIndex]!);
    remaining.splice(bestIndex, 1);
  }

  return selected.map((c) => c.id);
}
