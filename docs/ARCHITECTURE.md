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

See the build brief for the full data model, retrieval pipeline, and MCP
tool surface.
