# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - unreleased

Date will be filled in when this version is actually published to npm.

First release: a local-first, portable memory MCP server, shared across every
MCP client, stored in a single file the user owns.

### Added

- A single background daemon owning one WAL-mode SQLite file (`sqlite-vec` +
  FTS5) as the source of truth for memory, with a swappable storage driver.
- MCP connectivity over Streamable HTTP, plus a stdio→HTTP shim for
  stdio-only clients (such as Claude Desktop) that auto-starts the daemon so
  every client shares the same store.
- Hybrid retrieval: vector KNN and FTS5 keyword search fused with Reciprocal
  Rank Fusion, then re-ranked by relevance, recency, and importance, with MMR
  for diversity.
- Local embeddings via ONNX (`bge-small-en-v1.5`), with an FTS-only mode that
  requires no model download for a genuinely zero-config start.
- The full MCP tool surface: `remember`, `recall`, `get_context`,
  `list_memories`, `update_memory`, `forget`, `export_memories`, and
  `import_memories`.
- Temporal supersede-not-delete: contradicted facts are marked with
  `valid_until` and `superseded_by` instead of being hard-deleted.
- A curation dashboard served at `/ui`, with its own `/api` namespace, and
  six sections: memories (list/search/inline edit/bulk forget with undo),
  timeline (the store as of any instant, excluding memories you have since
  forgotten), access log, connected apps,
  privacy (redaction mode, masked findings, delete-everything), and stats.
- `cairn setup`, wiring Claude Desktop, Claude Code, and Cursor to the same
  daemon.
- A Claude Code `SessionStart` recall hook (`cairn hook session-start`) that
  primes a session with a budgeted context block.
- A dependency-free ZIP archive format for `export_memories` /
  `import_memories`, plus importers for pasted Claude/ChatGPT memory text and
  ChatGPT custom instructions.

### Security

- The daemon binds to loopback only, checks the `Origin` header, and requires
  a bearer token.
- No telemetry of any kind.
- Secret and PII redaction runs at ingest, and a delete-everything action is
  available.
- `remember` never calls an LLM and never touches the network on the default
  path; writes only run a local embedding model, or skip embedding entirely
  in FTS-only mode.
