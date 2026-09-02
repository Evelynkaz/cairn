// The contract every embedding provider (local ONNX, local static, ollama,
// openai, voyage, and the "fake" test provider) implements. Storage
// (repositories/vectors.ts) depends on two invariants that every
// implementation MUST uphold and that this module cannot enforce by itself:
//
// 1. VECTORS ARE FINITE, NON-DEGENERATE AND L2-NORMALISED. vec0 tables are
//    created with `distance_metric=cosine`; cosine distance is only
//    meaningful and comparable across rows when every vector has unit
//    length, every component is a real finite number, and the vector is not
//    all-zero (a zero vector has no direction to be at distance 0 or 1 from
//    anything, but reads as distance 0 from every query, silently outranking
//    every real memory forever). Use `normalize` below before returning.
//    `assertEmbeddingShape` is the last line of defence before a vector
//    reaches the vector index -- it enforces this for every provider so a
//    malformed upstream response (e.g. a gateway that serialises floats as
//    strings, or an all-null row) fails loudly at the provider boundary
//    instead of silently poisoning every future recall.
// 2. `embed` RETURNS EXACTLY ONE VECTOR PER INPUT, IN ORDER. Callers zip the
//    result array positionally against the input `texts` array to attach a
//    vector to a memory. A provider that silently drops or reorders an
//    entry corrupts the memory<->vector mapping with no error anywhere
//    downstream -- `assertEmbeddingShape` exists so that failure happens
//    loudly at the provider, not deep inside sqlite-vec.
// 3. `dim` IS FINAL AND STRICTLY POSITIVE FROM THE MOMENT A PROVIDER EXISTS.
//    Callers such as createIndexer() stamp a vector space from
//    `(modelId, dim)` at construction time and write vectors into it
//    afterwards; a `dim` that is 0 or unknown at that point, or that
//    changes later, is a dimension that can disagree with the table it was
//    already written into. This is exactly why every provider factory is
//    ASYNCHRONOUS: it gives a provider (e.g. one backed by a hosted API
//    whose dimension is not knowable without a network round trip) a chance
//    to determine its real dimension before anyone can observe it. Never
//    resolve a provider factory with `dim: 0` "to fix later" -- there is no
//    later; the vector space is already created by the time embed() is
//    first called.

export type ProviderName = "off" | "local-onnx" | "local-static" | "ollama" | "openai" | "voyage" | "fake";
// "fake" is a deterministic, offline, dependency-free provider (see fake.ts)
// that exists solely so tests never have to touch a real model or the
// network. It is intentionally not reachable through configuration
// (registry.ts never resolves to it) -- tests construct it directly.

export interface EmbeddingProvider {
  /** Stamped into vector_spaces.model_id. MUST uniquely identify the exact
      model, because BUILD_BRIEF §3 forbids KNN across mismatched models. */
  readonly modelId: string;
  /** Fixed and strictly positive for the provider's whole lifetime -- see
      invariant 3 above. Never 0, and never reassigned after construction. */
  readonly dim: number;
  readonly name: ProviderName;
  /** True if embed() performs network I/O. The default path must be false (§2). */
  readonly requiresNetwork: boolean;
  /** Batch API: providers amortise model invocation over the batch. Returns one
      L2-normalised vector per input, in input order, each of length `dim`. */
  embed(texts: string[]): Promise<Float32Array[]>;
  close(): Promise<void>;
}

// Returns a new, L2-normalised copy of `v`; the input is never mutated. A
// zero vector (all-zero input) has no direction to normalise onto, so it is
// returned as-is (as a copy) rather than dividing by zero.
export function normalize(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    sumSq += x * x;
  }
  const norm = Math.sqrt(sumSq);
  if (norm === 0) {
    return v.slice();
  }
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) {
    out[i] = (v[i] ?? 0) / norm;
  }
  return out;
}

// A vector whose L2 norm falls below this is treated as degenerate (all
// zeros, or close enough to it that cosine distance is meaningless) rather
// than a real direction.
const MIN_NORM = 1e-6;

// Every provider implementation must call this before returning from
// embed(), so a shape mismatch fails loudly and immediately at the provider
// boundary -- see invariant 2 above. This is also the last line before a
// vector reaches the vector index: it additionally rejects any vector with a
// non-finite component (NaN/Infinity, e.g. from a gateway that serialises
// floats as strings or JSON `null`) and any vector with ~zero L2 norm (e.g.
// from an all-null row), because either one is written into vec0 as a
// vector that sits at distance 0 from every future query and silently
// outranks every real memory forever.
export function assertEmbeddingShape(
  vectors: Float32Array[],
  texts: string[],
  dim: number,
  providerName: ProviderName,
): void {
  if (vectors.length !== texts.length) {
    throw new Error(
      `embedding provider "${providerName}" returned ${vectors.length} vectors for ${texts.length} input texts`,
    );
  }
  // Ordering rule: for each vector, report the most structural problem
  // first -- length, then non-finite components, then zero norm. A vector
  // of the wrong length is often also all-zero (e.g. an unpopulated
  // placeholder), and "degenerate vector" would send a reader off to check
  // normalisation when the real, actionable problem is a dimension
  // mismatch. Do not reorder these checks.
  for (let i = 0; i < vectors.length; i++) {
    const vector = vectors[i];
    if (vector === undefined || vector.length !== dim) {
      throw new Error(
        `embedding provider "${providerName}" returned a vector of length ${vector?.length} at index ${i}, expected dim ${dim}`,
      );
    }
    let sumSq = 0;
    for (let j = 0; j < vector.length; j++) {
      const x = vector[j] ?? 0;
      if (!Number.isFinite(x)) {
        throw new Error(
          `embedding provider "${providerName}" returned a non-finite component at batch index ${i}, component index ${j}`,
        );
      }
      sumSq += x * x;
    }
    if (Math.sqrt(sumSq) < MIN_NORM) {
      throw new Error(
        `embedding provider "${providerName}" returned a zero (degenerate) vector at index ${i}`,
      );
    }
  }
}
