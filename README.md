# Cairn

[Русская версия — README_RU.md](README_RU.md)

**Persistent memory for your AI that you actually own — local-first, shared across every MCP client, one command to install, a dashboard to see and edit everything. No cloud, no account, no API key.**

[![npm version](https://img.shields.io/npm/v/cairn-mem.svg)](https://www.npmjs.com/package/cairn-mem)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![CI](https://github.com/Evelynkaz/cairn/actions/workflows/ci.yml/badge.svg)
![Node >=22.13](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)

![Cairn dashboard hero screenshot](assets/hero.png)

> Status: published. Cairn ships to npm as [`cairn-mem`](https://www.npmjs.com/package/cairn-mem)
> (current: `0.1.2`) — `npx cairn-mem` runs the real bin shim, `cairn
> --version` and `/health` both report the correct version. The daemon,
> dashboard API, all MCP tools, the SessionStart recall hook, and
> export/import are implemented and covered by tests (1009 tests, 1003
> passing, 0 failing, 6 skipped). CI is green on all three platforms — the
> unit suite on ubuntu-latest/macos-latest/windows-latest, and a smoke test
> on each that installs the tarball and runs it through `npx`, confirming
> the daemon starts and answers `/health`. That's evidence about the
> commit it ran on, not a permanent guarantee. The Claude/ChatGPT importers
> have still never been run against a real export from either product,
> though import now previews before writing so a bad parse is visible and
> reversible. The dashboard UI has been reviewed by hand in a browser
> against a seeded store and judged good; no automated browser test exists
> yet.

Repo: [github.com/Evelynkaz/cairn](https://github.com/Evelynkaz/cairn) · Package: [npmjs.com/package/cairn-mem](https://www.npmjs.com/package/cairn-mem)

## Why

- **Memory silos.** What you tell Claude, Cursor doesn't know — and vice versa. Every client keeps its own opaque, disconnected memory.
- **Privacy.** The built-in memory in most AI products is cloud-hosted, and increasingly the local, private, UI-having options (like mem0's OpenMemory) are being discontinued in favor of hosted accounts.
- **Vendor lock-in.** Memory tied to one product is memory you can't take with you, inspect, or delete on your own terms.

Cairn's wedge: **local-first**, **zero-config** (`npx cairn-mem` and you're running, no Docker/Postgres/keys), **zero-inference writes** (storing a memory never calls an LLM), **MIT-licensed** (the strongest local incumbents are AGPL), a **real dashboard** (most memory servers ship none), and **portable** — including importers that pull your existing Claude/ChatGPT memories in.

## Install

Published to npm as [`cairn-mem`](https://www.npmjs.com/package/cairn-mem):

```bash
npx cairn-mem        # run it — no install step, no keys, no Docker
cairn setup          # wire up Claude Desktop / Claude Code / Cursor
cairn ui             # open the dashboard
```

Or install it globally so the `cairn` command is always on `PATH`:

```bash
npm install -g cairn-mem
cairn setup
cairn ui
```

Every MCP client config `cairn setup` writes points at `npx -y
cairn-mem@latest`, so clients always run the latest published version
without a manual upgrade step.

**From source**, for contributors:

```bash
git clone https://github.com/Evelynkaz/cairn.git
cd cairn
npm install
npm run build
node dist/cli/index.js        # equivalent to `npx cairn-mem`
node dist/cli/index.js setup  # wire up Claude Desktop / Claude Code / Cursor
node dist/cli/index.js ui     # open the dashboard
```

## Usage

1. **Wire up your MCP clients.** `npx cairn-mem setup` edits real config files
   on your machine (Claude Desktop's config, Claude Code's `~/.claude.json`,
   Cursor's `~/.cursor/mcp.json`). Preview first — it's safer and shows you
   exactly what would change:

   ```bash
   npx cairn-mem setup --dry-run --print   # shows what would be written, writes nothing
   npx cairn-mem setup                     # writes it for real
   ```

   For Claude Code specifically, `claude mcp add cairn -- npx -y
   cairn-mem@latest` is the safer alternative, since Claude Code writes to
   `~/.claude.json` continuously while running. Full per-client steps:
   [docs/INSTALL.md](docs/INSTALL.md).

2. **Restart the client.** The daemon isn't running yet at this point — the
   stdio shim auto-starts it the first time the client actually connects.

3. **Just talk — the model calls memory tools itself.** Tell Claude "remember
   that I prefer TypeScript over JavaScript for new projects," then, in a
   fresh Cursor conversation, ask "what language do I prefer for new
   projects?" Both clients share the same daemon and the same SQLite file, so
   Cursor recalls what Claude stored. See [docs/TOOLS.md](docs/TOOLS.md) for
   what each of the 8 tools does and when a model should call it.

4. **Browse and curate in the dashboard:** `npx cairn-mem ui` starts the
   daemon if needed and opens it. From there you can search, edit, and delete
   memories, and approve imported memories before they're eligible for
   automatic recall (see "Dashboard" below).

5. **Claude Code users:** a `SessionStart` hook can make the first recall of
   a session automatic instead of relying on the model to call it — see
   [docs/RECALL_HOOK.md](docs/RECALL_HOOK.md).

## Architecture

A single local daemon owns one WAL-mode SQLite file (`sqlite-vec` + FTS5) as the single source of truth for memory. MCP clients connect either directly over Streamable HTTP or through a small stdio→HTTP shim (for stdio-only clients like Claude Desktop), so every client — Claude, Cursor, and others — shares the same store and sees the same state. Retrieval is hybrid: vector KNN and FTS5 keyword search fused with Reciprocal Rank Fusion, re-ranked by relevance, recency, and importance. Embeddings run locally via ONNX (no API key, no network call) by default.

## Dashboard

`cairn ui` opens a real dashboard served by the daemon, with six sections:
memories (list/search/inline edit/bulk forget with undo), timeline (the
store as of any instant, excluding memories you have since forgotten),
access log, connected apps, privacy (redaction
mode, masked findings, delete-everything, shown in `assets/privacy.png`),
and stats (`assets/stats.png`). See `assets/access-log.png` and
`assets/timeline.png` for the others. For setup details see
[docs/INSTALL.md](docs/INSTALL.md); for the MCP tools it sits alongside,
see [docs/TOOLS.md](docs/TOOLS.md).

## Tools

The MCP surface is deliberately small — 8 tools:

- `remember` — store a memory (local embed only, never an LLM call)
- `recall` — hybrid search (FTS5 + vector, RRF-fused, re-ranked)
- `get_context` — a budgeted, ranked context block to prime a session
- `list_memories` — browse/paginate the store
- `update_memory` — edit a memory (soft, audited)
- `forget` — delete a memory (soft-delete with undo window)
- `export_memories` / `import_memories` — portable ZIP export/import, plus
  importers for pasted Claude/ChatGPT memory text and ChatGPT's exported
  custom instructions

`export_memories`/`import_memories` are listed as one line because §6 treats
them as one conceptual slot joined by a slash; the ceiling in §2 (`≤ ~7`,
against tool sprawl) is written with a tilde and aimed at competitors
shipping 50–83 tools, not at an eighth tool here.

## Privacy

Offline by default: no telemetry, no cloud calls in the default path, nothing leaves your machine unless you export it. Secret/PII detection runs at ingest. Deletion is first-class, with an undo window and a one-click "delete everything."

## Roadmap

**Shipped:** the daemon + stdio shim, MCP over stdio and Streamable HTTP,
hybrid retrieval, local ONNX embeddings, the 8 tools above, secret redaction
at ingest, the dashboard API, `cairn setup` / `cairn ui`, the Claude Code
SessionStart recall hook, and export/import with pasted Claude/ChatGPT text
and ChatGPT custom-instructions importers — all under test.

**Still open before v1 is "done":** an automated browser test for the
dashboard (it has been reviewed by hand, but nothing checks it in CI), and
the hero/demo GIFs from `docs/BUILD_BRIEF.md` §15. See
[docs/RELEASING.md](docs/RELEASING.md) for the release runbook.

**Deferred to v2+:** knowledge-graph / graph view, multi-user/teams/RBAC, cross-device sync, at-rest encryption (SQLCipher), opt-in LLM enrichment (fact extraction/summarization), feedback re-ranking, opt-in auto-capture hooks, a LanceDB large-scale backend, and auto-config for more clients.

See [docs/BUILD_BRIEF.md](docs/BUILD_BRIEF.md) for the full spec, [docs/INSTALL.md](docs/INSTALL.md) for per-client install steps, [docs/TOOLS.md](docs/TOOLS.md) for the MCP tool reference, and [CHANGELOG.md](CHANGELOG.md) for release history.

## FAQ

**What happens if the daemon isn't running?** MCP clients connecting via
the stdio shim auto-start it; the SessionStart hook, if the daemon can't be
reached within its own ~2s deadline, injects nothing rather than blocking
or failing the session — a session with no memory is preferred over one
that hangs or reads a stray error as an instruction.

**Does anything leave my machine?** No, by default. Everything lives in one
local SQLite file, embeddings run locally via ONNX, and there is no
telemetry anywhere in the code. Data only leaves the machine if you export
it yourself, or if you opt into a remote embedding/LLM provider.

**What does it cost to run?** Nothing. No API key, no account, and
`remember` never calls an LLM — writes only run a local embedding model (or
skip embedding entirely in FTS-only mode).

**How is this different from the memory built into Claude or ChatGPT?**
Those are per-product and, for the hosted versions, cloud-stored. Cairn is
one local store shared across every MCP client (Claude Desktop, Claude
Code, Cursor, …), inspectable and editable in a dashboard, and exportable
as a plain ZIP archive.

**Can I get my memories out?** Yes — `export_memories` writes a ZIP archive
of the episodic log and current facts; `import_memories` reads it back in.
Note the vendor-side importers (pasted Claude/ChatGPT memory text, ChatGPT
custom instructions) have not yet been exercised against a real export from
either product.

**What's not built yet?** An automated browser test for the dashboard (it
has been reviewed by hand and looks good, but nothing checks it in CI),
and everything under "Deferred to v2+" below.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
