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

Six independent audits (four security, one privacy, one retrieval-
correctness) ran against this release before it went out. All of the
following were reproduced and fixed; none require an attacker who already
has shell access to the machine.

- The daemon binds to loopback only, checks the `Origin` header, and requires
  a bearer token.
- No telemetry of any kind.
- Secret and PII redaction runs at ingest, and a delete-everything action is
  available.
- `remember` never calls an LLM and never touches the network on the default
  path; writes only run a local embedding model, or skip embedding entirely
  in FTS-only mode.
- Secret redaction previously ran on only one of the five ways text enters
  the store. It now runs on all of them — including import, which no
  longer trusts an archive's own claim that its text was already redacted.
- A finding cap silently limited how many secrets in a single memory were
  actually redacted, rather than only limiting what was reported; a memory
  with many secrets could store some of them raw. The cap on reporting is
  gone and every finding is now redacted.
- Redaction previews leaked most of a short secret (first and last four
  characters). Previews are now a fixed-length mask, and secret kinds whose
  prefix is itself high-entropy are masked completely rather than partially.
- "Delete everything" removed the data from normal reads but left the
  plaintext recoverable from the database file itself. It now removes it
  from the file on disk.
- The request-body size limit only applied before an MCP session was
  established; a large request sent inside an existing session was not
  bounded and could exhaust the daemon's memory.
- The daemon's own files — the database, its WAL sidecars, the auth token,
  and the log — were created world-readable. They are now created
  restrictively, and an existing home directory's permissions are no longer
  trusted as-is.
- `cairn setup` could be redirected by a symlink planted at its temp-file
  path into writing your client configuration somewhere else. It now
  refuses to follow one.
- A hostile import archive could inject large amounts of attacker-chosen
  text into an AI client's context by way of error messages, and could
  freeze the daemon by exploiting a slow path in archive parsing. Both are
  now bounded.

### Fixed

- Ranking returned plausible but wrong results in three ways: recency could
  outweigh relevance in the default (non-semantic) search mode, an
  unrelated but larger corpus could crowd out the correct answer in
  semantic search, and an important older memory could never surface in
  the budgeted context block used at session start. All three are fixed;
  ranking now weighs relevance, recency, and importance on a comparable
  scale and can always reach older, important memories.
