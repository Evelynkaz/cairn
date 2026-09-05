// Public storage API barrel. Internal helpers (row.ts, paging.ts, and driver
// internals) are deliberately not re-exported here. Memories/episodes
// mutation and audit recording go through `Store`; the vectors and audit
// read/type surface below is re-exported directly because milestones 2 and
// 4 need to name and call it without reaching past the barrel.

export { openStore } from "./store.js";
export type { Store, StoreOptions, StoreRecallOptions, StoreContextOptions, CallContext } from "./store.js";

export type { CairnDb, DbCapabilities } from "./db.js";

export {
  DEFAULT_SCOPE,
} from "./types.js";
export type {
  Scope,
  MemoryId,
  EpisodeId,
  Episode,
  Memory,
  AuditEvent,
  ClientRecord,
  RedactionAction,
  RedactionRecord,
} from "./types.js";

export type { AuditAction, ListAuditOptions, ListAuditResult, ClientAuditCounts } from "./repositories/audit.js";

export type { ImportMemoryResult, ImportMemorySkipReason } from "./repositories/memories.js";

export {
  recordRedactions,
  listRedactions,
  countRedactionsByKind,
  deleteRedactionsForMemory,
} from "./repositories/redactions.js";
export type {
  RedactionEntry,
  ListRedactionsOptions,
  ListRedactionsResult,
  RedactionKindCount,
} from "./repositories/redactions.js";

// Store.recall()/Store.context() return retrieval types directly; the MCP
// layer needs to name SearchHit (to shape its JSON response) without
// reaching past this barrel into ../retrieval/ itself.
export type { SearchHit } from "../retrieval/index.js";

export {
  ensureVectorSpace,
  getVectorSpace,
  listVectorSpaces,
  upsertVector,
  setVectorLive,
  deleteVector,
  knn,
  memorySeqsMissingVectors,
} from "./repositories/vectors.js";
export type { VectorSpaceRef } from "./repositories/vectors.js";

export { resolvePrivacyMode, setPrivacyMode, VALID_PRIVACY_MODES } from "./privacy-settings.js";
export type { PrivacyConfig } from "./privacy-settings.js";
export type { PrivacyMode } from "../privacy/index.js";

export { memoryStats } from "./repositories/stats.js";
export type { StoreStats, StoreStatsOptions } from "./repositories/stats.js";
