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

/**
 * Maximal Marginal Relevance (BUILD_BRIEF §7): greedily picks the
 * candidate maximising `lambda*relevance - (1-lambda)*maxSimilarityToAlreadySelected`,
 * trading pure relevance ranking for diversity in the top-K.
 *
 * A `null` vector (memory not yet embedded, or the store running in
 * FTS-only mode per §2 with no embedding model at all) cannot contribute a
 * similarity to anything. It is treated as similarity 0 against every
 * other candidate — a deliberate middle ground: it is never unfairly
 * PROMOTED (it cannot register a high similarity to already-selected items
 * to dodge the diversity penalty) and never silently DROPPED (it still
 * competes purely on its relevance term). If every candidate's vector is
 * null, every similarity term is 0 and MMR degrades exactly to plain
 * relevance ranking, so FTS-only mode never produces a broken or empty
 * result.
 */
export function mmr(candidates: readonly MmrCandidate[], k: number, lambda: number = DEFAULT_LAMBDA): string[] {
  if (k <= 0) return [];

  const remaining = candidates.slice();
  const selected: MmrCandidate[] = [];
  const limit = Math.min(k, candidates.length);

  while (selected.length < limit) {
    let bestIndex = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      let maxSim = 0;
      let hasValidPair = false;

      for (const sel of selected) {
        if (candidate.vector === null || sel.vector === null) continue; // missing vector => similarity 0, see above
        const sim = cosineSimilarity(candidate.vector, sel.vector);
        if (!hasValidPair || sim > maxSim) {
          maxSim = sim;
          hasValidPair = true;
        }
      }

      const mmrScore = lambda * candidate.relevance - (1 - lambda) * maxSim;
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
