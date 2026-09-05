import type { Migration } from "./index.js";

// BUILD_BRIEF §7: an empty-query get_context (i.e. every SessionStart hook
// on every client launch, §16) ranks the live pool by
// (importance DESC, created_at DESC) before MMR (see
// ../../retrieval/context.ts's loadImportancePool). With no supporting
// index, EXPLAIN QUERY PLAN showed a full scan of `memories_live` plus a
// temp B-tree for the ORDER BY -- unscoped it is
// `SCAN memories USING INDEX idx_memories_live_hash` (that index exists for
// dedupe, not for this sort) with `USE TEMP B-TREE FOR ORDER BY`; scoped it
// is an index SEARCH on scope but still the same temp B-tree sort. That
// means every client launch on every scope sorted the whole live pool.
//
// Partial, restricted to exactly the predicate memories_live already
// encodes (`deleted_at IS NULL AND valid_until IS NULL`): a forgotten or
// superseded row must never sit in an index retrieval reads through, and
// keeping the index scoped to the live pool keeps it no larger than what
// get_context ever actually ranks.
const DDL = `
CREATE INDEX idx_memories_scope_importance_created ON memories(scope, importance DESC, created_at DESC)
  WHERE deleted_at IS NULL AND valid_until IS NULL;
`;

export const migration003: Migration = {
  version: 3,
  name: "importance-index",
  up(driver) {
    driver.exec(DDL);
  },
};
