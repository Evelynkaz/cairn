# Security Policy

Cairn's pitch is privacy: a memory store that lives on your machine and
never has to trust a cloud service. That only means something if the
project takes its own security seriously, so here is the actual posture,
plainly.

## Current posture

- The daemon binds to **loopback only** (`127.0.0.1`), checks both `Origin`
  and `Host` on every request, and requires a bearer token minted on
  startup. There is no remote surface by design.
- **No telemetry, ever.** Nothing about your usage or your memories leaves
  the machine.
- `remember` and the rest of the default write path **never call an LLM and
  never touch the network**; embeddings run locally, or are skipped
  entirely in FTS-only mode.
- Secret and PII redaction runs at ingest, across every path text can enter
  the store (direct writes, edits, supersede, import, and episode
  metadata).
- **At-rest encryption is deliberately deferred to v2.** `cairn.db` is a
  plain SQLite file. If someone else gets a copy of it — a stolen laptop,
  a shared machine, a careless backup — they can read every memory in it.
  This is a known, accepted gap for v1, not an oversight, and you should
  plan around it (full-disk encryption, a machine only you can access)
  until it's addressed.

## Scope

In scope for a security report:

- The daemon's loopback HTTP surface (the dashboard API, health/status
  endpoints, auth/token handling).
- The MCP tool surface (`remember`, `recall`, `get_context`,
  `list_memories`, `update_memory`, `forget`, `export_memories`/
  `import_memories`), including how tool output is bounded and returned
  to the calling client.
- The importers and the ZIP archive format they read and write.
- Secret/PII redaction (bypasses, leaks in previews, or anything stored
  unredacted that shouldn't be).
- `cairn setup`'s writes to files outside the Cairn store (client configs
  such as `~/.claude.json`, `~/.cursor/mcp.json`, the Claude Desktop
  config).

Out of scope:

- Anything that requires an attacker who already has a shell on the user's
  machine, or write access to `CAIRN_HOME`. The store is a local file
  owned by the user; if someone already controls the account, the memory
  store is the least of their problems. (The at-rest encryption gap above
  is the one exception worth knowing about even under this model — a
  stolen *file*, not a live shell, can still read it.)
- Social engineering, physical access, and issues in third-party
  dependencies that don't have a Cairn-specific exploit path (report those
  upstream).

## Reporting

Please use GitHub's private vulnerability reporting for this repository
(Security tab → "Report a vulnerability") rather than a public issue. It
requires no email address and keeps the report private between you and the
maintainer until a fix is out.

## What to expect

Cairn is maintained by one person. There is no formal SLA — response and
fix times are best-effort, not promised. You will get an acknowledgment
and, if the report is valid, credit in the changelog once it's fixed,
unless you ask not to be named.
