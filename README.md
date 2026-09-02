# Cairn

**Persistent memory for your AI that you actually own — local-first, shared across every MCP client, one command to install, a dashboard to see and edit everything. No cloud, no account, no API key.**

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange.svg)

<!-- ![Cairn dashboard hero screenshot](assets/hero.png) -->

> Status: pre-alpha — under active development. Not usable yet.

## Why

- **Memory silos.** What you tell Claude, Cursor doesn't know — and vice versa. Every client keeps its own opaque, disconnected memory.
- **Privacy.** The built-in memory in most AI products is cloud-hosted, and increasingly the local, private, UI-having options (like mem0's OpenMemory) are being discontinued in favor of hosted accounts.
- **Vendor lock-in.** Memory tied to one product is memory you can't take with you, inspect, or delete on your own terms.

Cairn's wedge: **local-first**, **zero-config** (`npx cairn` and you're running, no Docker/Postgres/keys), **zero-inference writes** (storing a memory never calls an LLM), **MIT-licensed** (the strongest local incumbents are AGPL), a **real dashboard** (most memory servers ship none), and **portable** — including importers that pull your existing Claude/ChatGPT memories in.

## Planned install

```bash
# planned — not yet published
npx cairn
```

## Architecture

A single local daemon owns one WAL-mode SQLite file (`sqlite-vec` + FTS5) as the single source of truth for memory. MCP clients connect either directly over Streamable HTTP or through a small stdio→HTTP shim (for stdio-only clients like Claude Desktop), so every client — Claude, Cursor, and others — shares the same store and sees the same state. Retrieval is hybrid: vector KNN and FTS5 keyword search fused with Reciprocal Rank Fusion, re-ranked by relevance, recency, and importance. Embeddings run locally via ONNX (no API key, no network call) by default.

## Tools

The MCP surface is deliberately small (≤7 tools):

- `remember` — store a memory (local embed only, never an LLM call)
- `recall` — hybrid search (FTS5 + vector, RRF-fused, re-ranked)
- `get_context` — a budgeted, ranked context block to prime a session
- `list_memories` — browse/paginate the store
- `update_memory` — edit a memory (soft, audited)
- `forget` — delete a memory (soft-delete with undo window)
- `export_memories` / `import_memories` — portable ZIP export/import, including Claude/ChatGPT memory importers

## Privacy

Offline by default: no telemetry, no cloud calls in the default path, nothing leaves your machine unless you export it. Secret/PII detection runs at ingest. Deletion is first-class, with an undo window and a one-click "delete everything."

## Roadmap

**v1:** daemon + stdio shim, MCP over stdio and Streamable HTTP, hybrid retrieval, local ONNX embeddings, the ≤7 tools above, secret redaction at ingest, a polished dashboard, `npx cairn` / `cairn setup` / `cairn ui`, a Claude Code SessionStart recall hook, and export/import with Claude/ChatGPT importers.

**Deferred to v2+:** knowledge-graph / graph view, multi-user/teams/RBAC, cross-device sync, at-rest encryption (SQLCipher), opt-in LLM enrichment (fact extraction/summarization), feedback re-ranking, opt-in auto-capture hooks, a LanceDB large-scale backend, and auto-config for more clients.

See [docs/BUILD_BRIEF.md](docs/BUILD_BRIEF.md) for the full spec.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
