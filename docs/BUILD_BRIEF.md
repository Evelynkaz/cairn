# BUILD BRIEF — "Cairn": local-first, portable memory for AI agents

> Paste this whole document as the initial spec for the AI coding agent in a fresh repo.
> It is the single source of truth for what to build, why, and in what order.
> (Name "Cairn" is a placeholder — verify npm name / GitHub org / `.dev` domain / trademark
> before publishing; fallbacks: **Marrow**, **Loam**. Use a suffix if needed: `cairn-mcp`, `usecairn`.)

---

## 0. THE ONE-LINER

**Persistent memory for your AI that you actually own — local-first, shared across every MCP client (Claude, Cursor, …), one command to install, a real dashboard to see and edit everything, no cloud, no account, no API key.**

Tagline: *"Your AI's memory, on your machine."*

---

## 1. WHY THIS EXISTS (the wedge — read before writing any code)

The agent-memory category is crowded (200+ MCP memory servers), so we win on a **specific unowned combination**, not on features. Ground the whole design in these facts:

- **mem0 deleted OpenMemory** (the local + private + has-a-UI path) from its monorepo in mid-2026 and pushed users to a hosted, OAuth server. The most-cited local+private+UI option abandoned that exact niche.
- The strongest local incumbents are **AGPL-licensed** (Vestige, Basic Memory) — commercial-unfriendly and hard to embed. **Basic Memory has no first-party dashboard** (it leans on Obsidian). **Vestige** is close to our pitch but AGPL, gates cross-machine sync behind a $19/mo Pro tier, and needs a ~130 MB model download to start.
- **Almost every "smart" memory system makes an LLM API call on every write** (fact extraction): mem0, Letta, Graphiti, cognee, Memori, Redis. That is the dominant cost, latency, and privacy sink.
- Built-in memory (ChatGPT/Claude) is **vendor-locked, opaque, non-portable, non-exportable** — the reason a portable layer exists at all.

**Therefore Cairn owns this combination that no one delivers all at once:**
1. **True zero-config** — one command / single artifact. No Docker, no Postgres/Qdrant/Neo4j, no forced multi-hundred-MB download to *start*.
2. **Zero-inference writes by default** — storing a memory NEVER requires an LLM or an API key. Local embeddings power search; LLM "enrichment" (fact extraction, summarization) is strictly **opt-in**.
3. **Permissive license (MIT)** in the local-first tier (where the leaders are AGPL) — so others can embed and trust it.
4. **A genuinely good curation dashboard** — only ~3 of 200+ servers ship a real UI. Ours is a first-class product surface.
5. **Portability as identity** — one inspectable file, full export/import, and **importers that pull your existing Claude/ChatGPT memories in**. "Escape vendor lock-in, bring your memory with you."

Do NOT drift into a me-too. If a feature doesn't serve local-first, zero-config, privacy, portability, or the UI, it is v2+ or out.

**Explicitly NOT our target:** the enterprise agent-platform buyer (that's mem0/Zep/Letta). Our user is the **privacy-conscious individual** who uses Claude Code/Desktop *and* Cursor daily and hates re-explaining their context.

---

## 2. NON-NEGOTIABLE PRINCIPLES

- **Local-first & offline by default.** No network calls in the default path. No telemetry, ever. Data never leaves the machine unless the user explicitly exports it.
- **Zero-config.** `npx cairn` (or a single binary) must work immediately with no keys, no Docker, no external services. Ship an instant-start mode (keyword/FTS search) that needs no model download; semantic embeddings download on first use with clear consent, or are opt-in.
- **Writes are dumb and instant.** `remember` = store + (local) embed. Never an LLM call. LLM enrichment is a separate, opt-in path.
- **Small, sharp tool surface (≤ ~7 MCP tools).** Tool sprawl past ~50 tools measurably degrades client accuracy; some competitors ship 50–83 tools — we do the opposite.
- **Privacy is a feature, not a footnote.** Secret/PII detection at ingest; deletion is first-class; a one-paragraph honest privacy statement.
- **The dashboard is a product, not an afterthought.** It is the screenshot that sells the repo.
- **Cross-client shared memory.** What you tell Claude, Cursor can recall. One store, many clients.
- **English-only** in the codebase, comments, and docs. Conventional Commits.

---

## 3. TECH STACK (decided — don't relitigate without reason)

- **Language/runtime:** **TypeScript on Node ≥ 22**, MCP via the official `@modelcontextprotocol/sdk`. Rationale: the TS MCP SDK is the most mature; `npx` gives a true zero-install one-liner; embeddings run in-process (no Python, no second process); a local web UI ships from the same process. Offer an optional **Bun `--compile` single-binary** build for users who don't want Node.
- **Store:** **SQLite in WAL mode** as the single source of truth — one `.db` file that holds everything (episodic log, facts, entities, vectors, FTS index, metadata). Portable, backup-able (copy one file), inspectable.
- **Vectors:** **`sqlite-vec`** (`vec0` virtual tables) with **metadata columns** (`user_id/scope`, `created_at`, `importance`, `type`, `model_id`, `dim`) for filterable KNN. Pin the version (pre-1.0). Keep a `VectorStore` interface so **LanceDB** can be a documented large-scale backend later.
- **Keyword search:** **SQLite FTS5** (BM25).
- **Hybrid retrieval:** run vector KNN and FTS5 in parallel, **fuse with Reciprocal Rank Fusion (RRF, k≈10)** — avoids score-normalization headaches; industry default.
- **Embeddings (default, offline):** **`bge-small-en-v1.5`** (384-dim, ~130 MB) via **Transformers.js / ONNX Runtime**, in-process. Ship a **static `model2vec potion-retrieval-32M`** fast fallback for weak hardware / instant bulk indexing. **Instant-start FTS-only mode requires no model at all.**
- **Pluggable `EmbeddingProvider`:** `local-onnx` (default), `local-static` (model2vec), `ollama` (nomic-embed-text/mxbai), `openai`, `voyage`. **Stamp `model_id` + `dim` on every vector row; never KNN across mismatched models; re-embed as a background migration on provider switch.** API providers are an opt-in "max quality" override — the app is fully functional offline with none set.
- **Cross-platform:** must run on macOS, Windows, Linux. CI builds + smoke-tests on all three.

---

## 4. ARCHITECTURE — one daemon, many clients, one file

A **single background daemon owns the data; every client talks to it**, so all clients share one memory and the UI/HTTP/stdio/CLI always see the same state.

```
Claude Desktop ─stdio─┐
Claude Code ────stdio─┤→ [stdio shim] ─┐
Cursor ─────────http──┼───────────────┼→  caird (daemon, 127.0.0.1:PORT)
Windsurf/VSCode ─http─┘               │      ├─ MCP over Streamable HTTP + SSE
CLI  ─────────────────────────────────┤      ├─ MCP resources + notifications/resources/updated
Web UI (/ui) ─────────────────────────┘      └─ ONE WAL-mode SQLite file (sqlite-vec + FTS5)
```

- **Transport: support BOTH stdio and Streamable HTTP.** The daemon speaks Streamable HTTP (+SSE) on `127.0.0.1`. Ship a tiny **stdio→HTTP shim** for clients that only do stdio (Claude Desktop/Code). ~59% of MCP builders use HTTP, but local clients still commonly use stdio — support both.
- **The shim auto-starts the daemon** if the port is dead, so the user never manages a service.
- **SQLite concurrency:** WAL mode + `busy_timeout` + `BEGIN IMMEDIATE` for writes. Concurrent reads during writes; writes serialize through the one daemon writer. All clients must be same host (accepted — it's local-first).
- **Local security:** bind loopback only; **check the `Origin` header** (defend against browser DNS-rebinding); optional bearer token in a `0600` file the shim reads. No OAuth for local.

---

## 5. DATA MODEL

Two layers in one DB:
- **Episodic log** (append-only): raw items the user/agent chose to store. Cheap, keeps the source (a 2026 ablation found raw chunks can beat extracted facts for long histories — never throw the source away).
- **Facts / memories** (the queryable unit): `id, text, embedding, scope, tags[], source_client, importance (0–1), created_at, updated_at, last_accessed, access_count, valid_from, valid_until, superseded_by, provenance(episode_id)`.

Rules:
- **Scopes/namespaces** (e.g. per-project) so memories don't bleed across unrelated work — this is what makes cross-client sharing useful rather than noisy. Default scope + explicit scoping.
- **Temporal validity, cheaply (from Zep):** on contradiction, **do not hard-delete** — set the old memory's `valid_until = now` and add the new one (`superseded_by`). Enables "what did I know last week" and honest audits. (Stale-memory supersession is the genuinely hard, unsolved problem in this space — handle it deliberately; naive append-only memory becomes actively harmful when facts change.)
- **Importance + recency + access** feed ranking and (later) forgetting.
- **Audit trail:** record every read/write with the source client so the dashboard's access log is truthful.

---

## 6. MCP SURFACE (the whole tool set — resist adding more)

Verb-first, snake_case, short names. Each description must state **WHEN to call it**, with examples (this is how you get the model to actually use memory — see §8).

1. `remember(content, tags?, scope?, source?, importance?)` → stores; returns `{id, deduped?}`. **Never calls an LLM.** Local-embed + optional near-duplicate merge (heuristic/cosine, not LLM).
2. `recall(query, limit?, scope?, filters?)` → hybrid FTS5+vector+RRF, re-ranked; returns `[{id, text, score, source, created_at, tags}]`.
3. `get_context(query, token_budget?=~800)` → the workhorse: one call returns a ranked, deduped, budget-bounded context block (with provenance) to prime a session. **Budget it — do not dump everything (context pollution is a documented failure).**
4. `list_memories(scope?, filter?, cursor?)` → browse/paginate (also powers the dashboard through the same store).
5. `update_memory(id, content?, tags?, importance?)` → edit (soft, audited).
6. `forget(id | query, scope?)` → delete (soft-delete + undo window; deletion is first-class).
7. `export_memories(scope?)` / `import_memories(archive)` → portable ZIP + SHA256 manifest (also home for the **Claude/ChatGPT memory importers**).

Also:
- Expose an **MCP Resource** (`cairn://memory/...`) mirroring the store so resource-capable clients browse/subscribe without a tool call; emit `notifications/resources/updated` on mutation.
- Ship **MCP Prompts** for common flows ("summarize what you know about me", "save this decision").
- **Forgiving parameter aliases** (accept `q`/`text` for `query`) so a mis-named param doesn't fail the call.
- Defer a graph/entity tier (`relate`, entity ops) to v2 — flat memories + tags + hybrid search first (mem0's own data shows the graph variant barely beats plain vector at ~3× cost).

---

## 7. RETRIEVAL PIPELINE

`vector KNN ⨁ FTS5 BM25` → **RRF fuse (k≈10)** → re-rank with the generative-agents blend **score = α·relevance + β·recency(exp decay) + γ·importance** → **MMR** for diversity in top-K → optional pluggable cross-encoder reranker for a "quality mode" (off by default). Boost `access_count`/`last_accessed`. Background job soft-prunes low-importance, never-retrieved old episodic entries (hard forgetting) while keeping facts.

---

## 8. MAKING THE MODEL ACTUALLY USE MEMORY (critical — most tools fail here)

Instruction-only orchestration is ~60–70% reliable. Layer these, strongest first:
1. **Deterministic recall via a client hook, not the model's goodwill.** Ship a **Claude Code `SessionStart` hook** (and a Cursor hook where supported) that runs `get_context` and injects a **budgeted (~800-token) ranked index** as additional context. **Do not auto-dump the whole store** — a well-known project caused "context pollution" doing that and had to retreat to a small index.
2. **Tool descriptions with triggers + examples** ("Call `remember` whenever the user states a durable preference, decision, personal fact, or correction. Call `recall`/`get_context` before answering anything that may depend on prior context.").
3. **A ready-to-paste system-prompt snippet + an MCP Prompt** users can install (the canonical "track identity/preferences/goals; update memory as you go" pattern).
4. **Feedback re-ranking (v1.1):** demote memories that led to repeated corrected mistakes. Evaluate on 30–50 real transcripts measuring "does the assistant stop repeating corrected mistakes," not retrieval metrics.

---

## 9. DASHBOARD (the differentiator — must look polished)

Served from the daemon at `http://127.0.0.1:PORT/ui` (no separate process). React/Vite (or Next) SPA hitting the daemon's HTTP/SSE; live-update via `notifications/resources/updated`.

v1 features:
- **Browse + hybrid search** (full-text + semantic) with filters (scope, tags, source client, date).
- **View / edit / delete** a memory; **bulk actions**; **soft-delete with undo**.
- Surface metadata: **source client**, created/updated timestamps, importance, tags.
- **Timeline view** (+ point-in-time via `valid_from/valid_until`).
- **Connected-apps / access log** — which client read/wrote what; per-app enable/pause (the OpenMemory idea, kept alive and done better) — a trust anchor.
- **"What does the agent know about me"** — a plain-English digest.
- **Tags / scopes**; **import/export** UI.
- **Privacy controls** — redaction preview; "what's stored / what was blocked"; toggle PII detection; one-click "delete everything."

Design it to be the README hero screenshot. A clean, fast, editable table + search beats a flashy empty graph — **defer the graph view to v2** (it's been done twice already; not a moat).

---

## 10. PRIVACY / SECURITY

- Offline by default, **no telemetry**, no cloud calls in the default path.
- **Secret/PII detection at ingest**, before storing: always-on **regex secret detectors** (API keys, tokens, private keys, etc.) + optional heavier PII (e.g. Presidio) behind a flag. Modes: `off / on / strict` (redact vs block). Show blocked/redacted items in the UI.
- **Deletion is first-class** and complete (with an undo window); "delete everything" always available.
- **Data portability:** export = one ZIP + SHA256 manifest; the `.db` file itself is one copyable/encryptable artifact.
- **Encryption at rest:** optional, opt-in via **SQLCipher** with a passphrase — **deferred to v2**, but state its absence honestly in v1 docs.

---

## 11. INSTALL & CROSS-CLIENT SETUP

- **One command:** `npx cairn` (primary). Optional `uvx`-style / single binary later.
- **`cairn setup`** auto-writes the MCP config into **Claude Desktop, Claude Code, and Cursor** (detect installed clients, back up existing config, be idempotent). Document manual config for Windsurf/VS Code/others.
- **`cairn ui`** opens the dashboard. **`cairn`** with no args runs/attaches the daemon.
- Config snippets to generate:
  - stdio (Claude Desktop/Cursor): `{"mcpServers":{"cairn":{"command":"npx","args":["-y","cairn@latest"]}}}`
  - Claude Code: `claude mcp add cairn -- npx -y cairn@latest` (or `--transport http http://127.0.0.1:PORT/mcp`)
  - HTTP (shared daemon): `{"mcpServers":{"cairn":{"url":"http://127.0.0.1:PORT/mcp","type":"http"}}}`
- **The cross-client demo must work end-to-end:** store a fact via Claude, recall it via Cursor (same daemon, same file).

---

## 12. MVP SCOPE

**v1 (build this):**
- Daemon + stdio shim; MCP over stdio + Streamable HTTP; MCP resources + notifications.
- SQLite (WAL) + sqlite-vec + FTS5; RRF hybrid retrieval; recency/importance/MMR re-rank.
- Local ONNX `bge-small` embeddings + instant FTS-only mode; pluggable providers (Ollama/OpenAI/Voyage) as opt-in.
- The ≤7 tools of §6; episodic log + facts; scopes; temporal supersede-not-delete; provenance; audit trail.
- Secret-regex redaction at ingest (`on` by default, `strict` optional).
- **Polished dashboard** (§9 v1 feature set).
- `npx cairn` + `cairn setup` (Claude Desktop + Claude Code + Cursor) + `cairn ui`.
- Claude Code **SessionStart hook** for deterministic budgeted recall.
- Export/import + **Claude/ChatGPT memory importers** (the lock-in-escape hook).
- README with hero GIF, one-command install, privacy statement, tool reference; MIT LICENSE; CI green on 3 OSes; demo GIF (VHS/asciinema).

**Deferred to v2+ (say so honestly in the roadmap):** knowledge-graph / graph viz; multi-user/teams/RBAC; cross-device sync (hard — most punt to Git/Syncthing or a paid tier; a *free, good* one is a later differentiator); at-rest encryption (SQLCipher); LLM enrichment pipeline (opt-in fact extraction/summarization/consolidation); feedback re-ranking; auto-capture hooks (opt-in, privacy/noise risk); LanceDB large-scale backend; auto-config for more clients.

---

## 13. REPO, LICENSE, QUALITY BAR

```
/            README.md  LICENSE(MIT)  package.json  THIRD_PARTY_LICENSES.md
/src         mcp server (tools), daemon (http/sse), storage layer, embedding layer, retrieval
/src/shim    stdio→http shim
/dashboard   local web UI (built assets served by the daemon)
/cli         setup/install, ui, daemon commands
/docs        install-per-client, tool reference, privacy statement, roadmap, architecture
/examples    sample configs (Claude Desktop, Claude Code, Cursor)
/.github     issue templates, CI (build + cross-platform smoke test)
/assets      README hero GIF + screenshots
```

- **License: MIT** (maximize adoption/embedding; the local-first leaders being AGPL is part of our wedge). Vendor deps with licenses recorded in `THIRD_PARTY_LICENSES.md`.
- **Quality:** typed, tested. Unit tests for storage/retrieval/RRF/redaction; an **integration test that proves the cross-client shared-store flow** (write via one MCP session, read via another). Bound/paginate every tool's output. No secrets or telemetry. Handle SQLite concurrency correctly (WAL, busy_timeout, single writer).
- **Definition of done for v1:** `npx cairn` runs with zero config/keys/Docker and passes smoke tests on macOS/Windows/Linux; `cairn setup` wires Claude + Cursor and the "tell Claude → ask Cursor" demo works; all ≤7 tools implemented with bounded output; dashboard does list+search+edit+delete+timeline+access-log+stats and looks good in a screenshot; README has hero GIF + install-in-first-screenful + privacy statement + tool reference + roadmap + ~4 badges; demo GIF recorded; CI green on 3 OSes; honest one-paragraph privacy statement (what's stored, where, that nothing leaves the machine, how to delete all).

---

## 14. TRAPS TO AVOID (learned from the incumbents)

- Don't lead with "cognitive/neuroscience decay/forgetting" or "3D graph" — **already shipped** by Vestige/doobidoo; not a moat.
- **Don't LLM-call on write** in the default path — that's the tax everyone else pays; our default is dumb+instant.
- **Don't dump the whole memory** into context on recall — budget it.
- **Don't cite self-run benchmarks** (LongMemEval/LoCoMo numbers in this space are contested); if you must, use an independent harness.
- **Don't sprawl tools** past a handful.
- Treat **stale-fact supersession** as a real, hard problem — supersede with temporal validity, don't naively append.

---

## 15. LAUNCH (build the README/demo for this)

- **README top-to-bottom:** hero GIF (AI in Cursor recalling a fact told to Claude) → one-liner + tagline → `npx` install in the first screenful → the problem (silos/privacy/lock-in) → cross-client demo → dashboard screenshot → the ≤7 tools → privacy statement → roadmap (deferred features shown as "coming") → badges + FAQ.
- **Show HN title options:** "Show HN: Cairn – Local-first memory for your AI, shared across Claude and Cursor" / "Show HN: Give your AI persistent memory that never leaves your machine" / "Show HN: the local, private AI memory that mem0 stopped shipping."
- Launch mid-week ~12–17 UTC; post a founder comment within 5 min (motivation, stack, honest current limits, the ask). Cross-post r/LocalLLaMA, r/ClaudeAI, r/cursor, X — with the GIF. Screenshots ≈ +42% stars; a 3-second GIF beats ten paragraphs.

---

## 16. BUILD ORDER (milestones for the coding agent)

1. **Storage core:** SQLite schema (episodic + facts + FTS5 + vec0 + audit), WAL/concurrency, migrations. Unit tests.
2. **Embeddings:** `EmbeddingProvider` interface; local ONNX bge-small via Transformers.js; FTS-only instant mode; model_id/dim stamping.
3. **Retrieval:** hybrid RRF + recency/importance/MMR re-rank. Tests on a seeded corpus.
4. **MCP server (HTTP+SSE)** with the ≤7 tools + resources + notifications; then the **stdio shim** + daemon auto-start.
5. **CLI:** `cairn` (daemon), `cairn setup` (Claude Desktop/Code + Cursor, idempotent, backup), `cairn ui`.
6. **Cross-client integration test:** write via one session, read via another.
7. **Dashboard:** list/search/edit/delete/bulk/undo, timeline, access log, stats, privacy controls, import/export.
8. **Privacy:** secret-regex redaction at ingest (on/strict), delete-everything.
9. **Recall hook:** Claude Code SessionStart budgeted injection; system-prompt snippet + MCP prompts.
10. **Portability:** export/import ZIP + manifest; Claude/ChatGPT memory importers.
11. **Polish:** README + hero GIF + demo GIF, MIT LICENSE, CI on 3 OSes, docs, roadmap.

Build incrementally, keep it runnable at every milestone, write tests as you go, and hold the line on the principles in §2 and the wedge in §1.
