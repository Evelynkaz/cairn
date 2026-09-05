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
timeline, audit log, connected clients, privacy actions). The SPA has six
sections (memories, timeline, access log, connected apps, privacy, stats),
all backed by that same `/api` namespace; it has been opened in a browser
against a seeded store and reviewed by hand, in addition to the `/api`
handlers' own tests — there is still no automated browser test. Every
memory carries provenance (`origin`: `user` / `import` / `unknown`, plus
`approved`), shown in the Memories section's Status column with per-row and
bulk Approve. Provenance draws a trust boundary at the point memory text
would otherwise reach a session automatically: a Claude Code `SessionStart`
hook (`cairn hook session-start`) calls `GET /api/context` on the local
daemon and prints a token-budgeted (~800 token) memory block into the
session before the user has said anything, so that path injects only
user-originated or approved memories; the `get_context` MCP tool, called
deliberately by a model, is not gated the same way and instead labels
provenance on what it returns.
Portability is a ZIP archive (`export_memories`/`import_memories`) holding
the episodic log and current facts, plus importers for pasted Claude/ChatGPT
memory text and ChatGPT's exported custom instructions; the vendor import
paths have not been run against a real export from either product.

See the build brief for the full data model, retrieval pipeline, and MCP
tool surface.
