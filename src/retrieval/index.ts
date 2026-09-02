// Public API of the retrieval layer — what `recall`/`get_context` (and any
// future dashboard/tuning script) import. Internal helpers (fts.ts's
// toMatchQuery, search.ts's row loaders, ...) are deliberately not
// re-exported here.

export { search } from "./search.js";
export type { SearchDeps, SearchOptions, SearchHit, SearchResult, RerankParts } from "./search.js";

export { getContext, estimateTokens } from "./context.js";
export type { ContextOptions, ContextBlock } from "./context.js";

export { rrfFuse, RRF_K } from "./rrf.js";
export type { FusedItem } from "./rrf.js";

export { rerank, DEFAULT_WEIGHTS } from "./rerank.js";
export type { RerankItem, RerankWeights } from "./rerank.js";

export { mmr, cosineSimilarity } from "./mmr.js";
export type { MmrCandidate } from "./mmr.js";
