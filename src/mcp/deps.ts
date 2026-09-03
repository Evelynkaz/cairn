// Wiring the MCP tool/resource/prompt layer needs from the rest of the app.
// `provider`/`space` are optional because BUILD_BRIEF §2's FTS-only mode is
// a fully supported default, not a degraded one -- a server built with
// neither set must work with no error.
//
// Store also grew its own optional provider/space (StoreOptions, milestone
// 4) now that recall/get_context live on the facade. They stay here too,
// deliberately, rather than only there: McpDeps remains the one place that
// says "what embedding config does this MCP server run with", fed per-call
// into store.recall()/store.context() (which accept an override). A single
// McpDeps field threaded into both call sites is not the two-independently-
// set-copies bug this milestone exists to remove.
//
// store.forgetWhere() (tools.ts) does NOT take a provider/space override --
// its options are `{ scope, limit, confirm }` only, so its preview search
// always runs on the Store's own construction-time default (StoreOptions,
// set outside McpDeps). It still goes through the same gated Store method
// rather than the MCP layer calling retrieval directly (§9/§10); it just
// cannot be steered per call the way recall/context can.
//
// `now` is injectable so retrieval's recency ranking is deterministic in
// tests, without touching Store (which has no clock override of its own).

import type { Store } from "../storage/index.js";
import type { VectorSpaceRef } from "../storage/index.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { MemoryEventBus } from "./events.js";

export interface McpDeps {
  store: Store;
  provider?: EmbeddingProvider | null;
  space?: VectorSpaceRef | null;
  now?: () => number;
  // The cross-session mutation fan-out (events.ts). Absent in every
  // existing single-server caller/test -- createMcpServer() falls back to
  // a private bus of its own, so a lone session behaves exactly as before.
  // The daemon (daemon/server.ts) creates ONE bus and shares it across
  // every session's McpDeps, which is what lets one client's write reach
  // another client's subscription.
  bus?: MemoryEventBus;
}
