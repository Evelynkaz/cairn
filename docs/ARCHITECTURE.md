# Architecture

This is a short summary. The authoritative description is
[BUILD_BRIEF.md §4 "Architecture"](BUILD_BRIEF.md#4-architecture--one-daemon-many-clients-one-file)
and §5 "Data model".

A single background daemon (`caird`) owns one WAL-mode SQLite file
(`sqlite-vec` + FTS5) as the single source of truth. MCP clients that speak
Streamable HTTP connect directly; stdio-only clients (Claude Desktop, Claude
Code) connect through a small stdio→HTTP shim that auto-starts the daemon if
it isn't running. A local dashboard is served from the same daemon process at
`/ui`. This design is what lets every client share one memory store and see
the same state live.

The dashboard is a static single-page app the daemon serves at `/ui`, backed
by its own `/api` namespace on the same process (memories, episodes,
timeline, audit log, connected clients, privacy actions); it has not yet
been opened in a browser, so its correctness is only established by the
`/api` handlers' own tests, not by rendering. A Claude Code `SessionStart`
hook (`cairn hook session-start`) calls `GET /api/context` on the local
daemon and prints a token-budgeted (~800 token) memory block into the
session, so recall does not depend on the model choosing to call a tool.
Portability is a ZIP archive (`export_memories`/`import_memories`) holding
the episodic log and current facts, plus importers for pasted Claude/ChatGPT
memory text and ChatGPT's exported custom instructions; the vendor import
paths have not been run against a real export from either product.

See the build brief for the full data model, retrieval pipeline, and MCP
tool surface.
