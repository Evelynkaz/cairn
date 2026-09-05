# Working on Cairn

Cairn is a local-first, portable **memory** MCP server: persistent memory for any MCP
client (Claude, Cursor, ...), stored in one file on the user's machine, with a real
curation dashboard. `docs/BUILD_BRIEF.md` is the complete spec; this file is the
always-on rules layer distilled from it. When in doubt, the brief wins — cite the
section number when you deviate or resolve an ambiguity from it.

## The soul (never violate) — §1–§2

- We win on an **unowned combination**, not on features: (1) true zero-config, (2)
  **writes NEVER call an LLM** (local embeddings only; LLM enrichment is opt-in), (3)
  permissive **MIT** license in a tier where the leaders are AGPL, (4) a genuinely good
  curation dashboard, (5) portability + importers from Claude/ChatGPT memory.
- Non-negotiables: local-first & offline by default; **no telemetry, ever**; zero-config
  (`npx cairn-mem`, no Docker/Postgres/forced model download to start — ship an instant
  FTS-only mode); **≤ ~7 MCP tools** (tool sprawl measurably degrades client accuracy);
  privacy is a feature (secret/PII redaction at ingest, deletion first-class); the
  dashboard is a product; cross-client shared memory (one store, many clients).
- If a feature doesn't serve local-first / zero-config / privacy / portability / the UI
  → it's v2+ or out. Don't build a me-too.

## The stack (decided — don't relitigate without strong reason) — §3

- TypeScript on Node ≥22, `@modelcontextprotocol/sdk`; distribute via `npx` (+ optional
  Bun single-binary).
- One WAL-mode SQLite file = source of truth: `sqlite-vec` (vec0, metadata cols) + FTS5;
  hybrid retrieval fused with RRF (k≈10), then recency·importance·relevance + MMR.
- Embeddings: local ONNX `bge-small-en-v1.5` default, static `model2vec` fallback,
  instant FTS-only mode with no model; pluggable `EmbeddingProvider`
  (ollama/openai/voyage) opt-in. Stamp `model_id` + `dim` per vector row; never KNN
  across mismatched models.
- Architecture: one background daemon owns the DB; clients connect via a stdio→HTTP shim
  + Streamable HTTP. The shim auto-starts the daemon. Loopback-only + `Origin` check.

## MCP surface — §6

- The whole tool set (≤7, verb-first, snake_case): `remember`, `recall`,
  `get_context`, `list_memories`, `update_memory`, `forget`,
  `export_memories`/`import_memories`. `remember` never calls an LLM.
- Each tool description states **WHEN** to call it (this is how you get the model to
  actually use memory).
- Expose an MCP resource mirror + `notifications/resources/updated` on mutation; accept
  forgiving parameter aliases (`q`/`text` for `query`).
- Defer a graph/entity tier to v2 — flat memories + tags + hybrid search first.

## Data & retrieval rules — §5, §7, §8

- Two layers in one DB: an append-only episodic log (keep the source) + queryable facts.
  Scopes/namespaces keep unrelated projects from bleeding together.
- **Temporal supersede-not-delete**: on contradiction set `valid_until` + `superseded_by`
  on the old memory, add the new one. Never naive hard-delete on a stale fact — that is
  the hard problem in this space; handle it deliberately.
- Retrieval: hybrid RRF fuse → recency/importance/relevance re-rank → MMR for diversity.
- Recall injection via a client `SessionStart` hook must be **budgeted (~800 tokens)** —
  never dump the whole store into context (documented "context pollution" failure).

## How to work

- Follow the build order in BUILD_BRIEF §16, milestone by milestone. Keep the repo
  runnable at every milestone.
- Write tests as you go: unit tests for storage/retrieval/RRF/redaction; an
  **integration test** proving the cross-client shared-store flow (write via one MCP
  session, read via another).
- Handle SQLite concurrency correctly: WAL mode, `busy_timeout`, single writer
  (`BEGIN IMMEDIATE`).
- Bound/paginate every tool's output. No secrets, no telemetry in code.
- English only, everywhere. Conventional Commits; explain *why* in the body.
- Ask the user only when the brief is genuinely ambiguous — otherwise pick the option
  consistent with §1–§2 and proceed.

## Traps to avoid — §14

- Don't LLM-call on write in the default path.
- Don't dump the full memory store into context on recall.
- Don't cite self-run benchmarks (contested in this space).
- Don't sprawl tools past a handful.
- Don't lead with "cognitive decay" or "3D graph" framing — already shipped by
  incumbents, not a moat.

## Definition of done (v1) — §13

- `npx cairn-mem` runs zero-config, no keys, no Docker, smoke-tested on macOS/Windows/Linux.
- `cairn setup` wires Claude Desktop, Claude Code, and Cursor; the "tell Claude → ask
  Cursor" cross-client demo works end-to-end.
- All ≤7 tools implemented with bounded output.
- Dashboard (list/search/edit/delete/timeline/access-log/stats) looks good in a
  screenshot.
- README with hero GIF, install-in-first-screenful, and an honest privacy statement.
- MIT `LICENSE`; CI green on all three OSes.
