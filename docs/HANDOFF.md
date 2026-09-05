# Handoff

Development is moving to a Linux VPS. This is what a fresh session needs to
be productive immediately. It is not a spec and not a changelog:
`docs/BUILD_BRIEF.md` is the spec, `CLAUDE.md` is the always-on rules layer.
Read both before writing code — cite the section number when you deviate.

## 1. Where the project stands

Status against BUILD_BRIEF §16's eleven milestones, read from `git log --oneline`:

| # | Milestone | Status |
|---|---|---|
| 1 | Storage core | done — `feat(storage)` x2 |
| 2 | Embeddings | done — `feat(embeddings)` |
| 3 | Retrieval | done — `feat(retrieval)` |
| 4 | MCP server + stdio shim + daemon auto-start | done — `feat(mcp)` |
| 5 | CLI (`cairn`, `cairn setup`, `cairn ui`) | done — `feat(cli)` |
| 6 | Cross-client integration test | done — `feat(integration)` |
| 7 | Dashboard | not started — `/dashboard` is an empty scaffold (`.gitkeep` only) |
| 8 | Privacy (redaction, delete-everything) | done — `feat(privacy)`, latest commit |
| 9 | Recall hook (Claude Code SessionStart) | not started — no hook code anywhere in the tree |
| 10 | Portability (export/import, Claude/ChatGPT importers) | not started — no `export`/`import` tool, `export_memories`/`import_memories` not registered |
| 11 | Polish (README hero GIF, demo GIF, MIT LICENSE, CI 3 OSes) | partial — CI green on 3 OSes, `LICENSE` (MIT) present; no hero/demo GIF, no `assets/` content beyond `.gitkeep` |

Six milestones fully done, one partial, four not started. By line/effort weight
(dashboard, the recall hook, and portability are each their own subsystem, not
small additions) the honest estimate is **roughly 50-55% of v1**, not
6/11 ≈ 55% read naively — the two biggest remaining pieces are the
**dashboard (M7)**, which is a whole SPA plus the HTTP endpoints it needs,
and portability (M10), which needs Claude/ChatGPT importers on top of
export/import. **The dashboard is the largest remaining milestone.**

Current test count: **558 tests, 556 pass, 2 skipped, 0 failing** (see §2 for
the run this came from). MCP tool count is **6**, not yet 7 — `export_memories`/
`import_memories` (M10) are not implemented, and `assert.equal(tools.length, 6)`
in `src/mcp/server.test.ts:186,210` will need updating, deliberately, when M10 lands.

CI (`.github/workflows/ci.yml`): matrix over `ubuntu-latest`, `macos-latest`,
`windows-latest`, `fail-fast: false`. Steps: `npm ci`, `npm run build`, a
`sqlite-vec` loadable-extension smoke check, then `npm test`. Last commit
(`5b6a9f0`) is on `main`; I did not query GitHub Actions for live run status —
verify that on the VPS with `gh run list` before trusting "green."

## 2. How to run it — every command below was executed in this session

```
$ npm install
up to date, audited 100 packages in 2s
found 0 vulnerabilities

$ npm run build
> cairn@0.0.0 build
> tsc -p tsconfig.json
(no output — clean compile)

$ npm run typecheck
> cairn@0.0.0 typecheck
> tsc -p tsconfig.json --noEmit
(no output; real 5.6s)

$ npm test          # runs: clean -> build -> node --test dist/**/*.test.js
...
1..558
# tests 558
# suites 0
# pass 556
# fail 0
# cancelled 0
# skipped 2
# todo 0
# duration_ms 21099.5
real 0m31.7s
```

`npm test` includes a full clean rebuild, so 31.7s wall is the honest
cold-start number; a plain `node --test dist/**/*.test.js` against an
already-built `dist/` is closer to 21.1s.

```
$ node dist/cli/index.js --help
cairn -- local-first memory MCP server

Usage:
  cairn                          run as the stdio MCP shim when not on a
                                  terminal (this is what an MCP client's
                                  {"command":"npx","args":["-y","cairn@latest"]}
                                  launches); otherwise print status
  cairn mcp                      always run the stdio MCP shim
  cairn daemon                   run the daemon in the foreground
  cairn status [--json]          show daemon, embedding, and database state
  cairn start                    start the daemon detached
  cairn stop                     stop the running daemon
  cairn ui [--no-open]           ensure the daemon is running, print/open the dashboard URL
  cairn setup [--client=<id>...] [--dry-run] [--print]
                                  write cairn into Claude Desktop / Claude Code / Cursor configs
  cairn embeddings status [--json]
  cairn embeddings enable [--provider=<name>] [--model=<id>]
  cairn embeddings disable
  cairn help | --help | -h       show this help
  cairn --version                show the installed version
```

`cairn ui` exists on the CLI surface but there is nothing at `/ui` to open
yet — M7 is not started (§1). Do not run bare `cairn setup`; see §4/§6 and
CONTRIBUTING.md.

## 3. The map

| Directory | What lives there | Depends on |
|---|---|---|
| `src/storage` | SQLite schema, migrations, WAL/concurrency, driver seam, repositories (memories, episodes, vectors, tags, audit, privacy-settings) | `src/util` (ids, text hashing) |
| `src/embeddings` | `EmbeddingProvider` interface, ONNX (`local-onnx`), static fallback, `http` (Ollama/OpenAI/Voyage-shaped), factory/registry, background indexer worker | `src/storage` (writes vectors) |
| `src/retrieval` | FTS5 query, RRF fusion, recency/importance re-rank, MMR, `get_context` budget assembly | `src/storage`, `src/embeddings` |
| `src/mcp` | The tool surface (`tools.ts`), MCP server wiring, resources/notifications event bus (`events.ts`) | `src/retrieval`, `src/storage`, `src/privacy` |
| `src/daemon` | HTTP+SSE server hosting the MCP server, runtime-file (port/pid/token) bookkeeping, lifecycle | `src/mcp` |
| `src/shim` | stdio-to-HTTP shim, daemon auto-start (`ensure-daemon.ts`) | `src/daemon` (spawns it) |
| `src/cli` | `cairn` entrypoint, arg parsing, command implementations (`status`/`start`/`stop`/`ui`/`embeddings`/`setup`), daemon lifecycle helpers | `src/daemon`, `src/shim`, `src/setup` |
| `src/setup` | Client detection + config writers for Claude Desktop / Claude Code / Cursor (`clients.ts`, `apply.ts`) | `src/config` (paths) |
| `src/config` | Path resolution (`CAIRN_HOME` vs. client config paths, which are deliberately outside it) | — |
| `src/privacy` | Regex secret detectors, redaction (on/strict), `deleteEverything` | `src/storage` |
| `src/integration` | Cross-client end-to-end test + harness (spawns real CLI processes) | everything above |
| `src/util` | `uuidv7`/`timestampFromUuidv7`, text normalization/hashing | — |
| `src/testing` | Shared test helpers (temp dirs) | — |
| `src/scripts` | `smoke-vec.ts`, the CI sqlite-vec loadable-extension check | `src/storage` |

Top-level `/dashboard`, `/cli`, `/assets` are pre-scaffolded per BUILD_BRIEF
§13's intended repo layout but are currently empty (`.gitkeep` only) — the
CLI's actual code is under `src/cli`, not `/cli`.

## 4. Invariants that are easy to break

- **Writes never call an LLM or touch the network.** `remember` only local-embeds (§2). `src/embeddings` API providers are opt-in and never on the default path.
- **Retrieval reads `memories_live`, never the base `memories` table.** The view filters soft-deleted and superseded rows; `src/storage/repositories/vectors.ts` and `memories.ts` join against it explicitly (see comments at `vectors.ts:269`, `memories.ts:94`). Querying `memories` directly will surface deleted/superseded rows in search.
- **`created_at` is derived from the id, never a second clock read.** `timestampFromUuidv7(id)` (`src/util/id.ts`) is the only source; `episodes.ts` and `memories.ts` both compute it this way so the row's timestamp can never disagree with its own id.
- **Integer parameters are normalised to `BigInt` at the driver seam**, documented in `src/storage/driver/types.ts` and `node-sqlite.ts:16` — an ordinary JS `number` bound where SQLite expects `INTEGER` is coerced to `BigInt` at that one boundary, not scattered through callers.
- **The tool ceiling is 6 today (design ceiling ≤7) and is asserted by a test** — `src/mcp/server.test.ts:186,210` (`assert.equal(tools.length, 6)`). A new tool added outside `export_memories`/`import_memories` should make you stop and re-read §6, not just bump the number.
- **`busy_timeout` must be armed before `PRAGMA journal_mode=WAL`, not after.** Reversing the order was measured at 18/40 two-process failures (`d934b79`); the order is now commented in `db.ts` as load-bearing.
- **The daemon listens on its port before it opens the database.** Only the kernel can arbitrate one thing cleanly — the port — so it decides first; opening the DB first let two racing daemons both start fighting over the file before either had lost (`d934b79`).
- **`cairn stop` (and the shim's attach path) require the daemon's own reported pid from `/health`, not just "pid exists + port answers."** A recycled pid can belong to an unrelated process; both call sites share the one predicate deliberately (`bd8f75b`).
- **`cairn setup` must never be run for real during verification** — always `--dry-run` or with `HOME`/`USERPROFILE` pointed at a temp directory. `CAIRN_HOME` does NOT isolate it: client config paths (`~/.claude.json`, `~/.cursor/mcp.json`, Claude Desktop's config path) are deliberately outside `CAIRN_HOME` (CONTRIBUTING.md).
- **A redaction finding never carries the secret it found.** Previews are masked; the raw value must appear in no table, including the FTS index (`5b6a9f0`). Do not "helpfully" log or return the matched string when touching `src/privacy`.
- **`npm test` must exit on its own — no `--test-force-exit`.** Anything a test or the code under test opens must be closed before the file's tests finish, or the process hangs; `src/shim/shim.test.ts` and `src/daemon/server.test.ts` close undici's global fetch dispatcher in `after()` for exactly this reason (CONTRIBUTING.md, `5945910`).

## 5. What this project has learned the hard way

- **Tests encoding the host OS.** A `C:\fake\home` literal is a relative path on POSIX; a `renameSync` onto a read-only file succeeds on POSIX (rename only needs directory write permission) but fails on Windows; a Windows-shaped client config marker landed where the POSIX detector never looks. Fix pattern each time: ask the code under test for the real path/behaviour instead of hardcoding a platform's own. Where a property is genuinely only measurable on one OS (open-fd counts via `/proc/self/fd`), skip elsewhere with `t.skip("reason")` (`2e1a4d6`, `14847fb`, CONTRIBUTING.md).
- **A security predicate duplicated in two places drifted.** The daemon-liveness/pid check was needed both by `cairn stop` and by the shim's attach-and-hand-over-the-token path; it now lives in one shared predicate rather than being reimplemented per call site (`bd8f75b`).
- **A test-runner flag silently dropped tests.** `--test-force-exit` masked a real hang, but on a slower CI runner it exited the process while a file still had queued subtests — 5 of `store.test.ts`'s tests vanished with no failure and no "cancelled" count. A green build that quietly ran less than it claimed is worse than a red one; the flag is gone and the actual hang (an unguarded module entrypoint) was fixed instead (`5945910`).
- **Killing a process by a recycled pid.** `cairn stop`'s old check ("pid exists" AND "port answers") could kill an unrelated process after a crash freed the pid for reuse; reproduced by killing a plain `node -e setInterval`. Fixed by requiring `/health` to return the daemon's own pid (`bd8f75b`).
- **A "finding" that carried the secret it reported.** Early redaction previews would have re-surfaced the very secret they existed to hide, in the dashboard and in error messages. Previews are masked now, and the test asserts the raw value is in no table at all, FTS included (`5b6a9f0`).

## 6. How work is done here

Per `CLAUDE.md`: the orchestrator (Opus) reads, plans, specs, and reviews;
it does not write code. Every file change goes through a builder agent
(Sonnet, `Edit`/`Write`), then a read-only reviewer verifies it. The `duo`
skill runs that full loop; use it for anything that changes files rather
than improvising the handoff.

Verification discipline this project actually holds itself to, visible
throughout the commit bodies in `git log`:
- **A fix is not accepted until the test that proves it has been shown to fail without it.** Several commits report exact before/after failure rates from repeated runs (e.g. "18/40 failed... 0/40 with it") rather than asserting the fix worked.
- **A claim is not reported until it has been reproduced**, ideally on the actual failing platform — "Local measurement is not evidence here: this Windows machine reports 0/60 both before and after. CI on macOS and ubuntu is the decisive check" (`25bfb73`).
- **Green output is not evidence on its own.** The `--test-force-exit` incident (§5) is the canonical example: the suite reported success while quietly running fewer tests than it claimed.

## 7. Open decisions that belong to the human

- **The package name.** BUILD_BRIEF §0 flags `cairn` as a placeholder pending npm-name / GitHub-org / `.dev`-domain / trademark verification, with `Marrow` and `Loam` as fallbacks (possible suffix: `cairn-mcp`, `usecairn`). `package.json` currently says `"name": "cairn"`. This needs a human to actually check availability before publish.
- **Publishing.** `package.json` has `"private": true` today, but `cairn setup` (`src/setup/apply.ts`, `src/cli/commands.ts`, `src/cli/index.ts`) writes `npx -y cairn@latest` into every client config it generates. That line will not work for any real user until the package is published under whatever name §0 settles on — a human decision (npm account, publish flow), not an agent one.
- **The demo/hero GIF.** BUILD_BRIEF §15 wants a hero GIF (Claude tells it something, Cursor recalls it) and a launch demo GIF (VHS/asciinema) — both need a human at a screen with a working dashboard, which doesn't exist yet (M7).

## 8. What comes next, in BUILD_BRIEF §16 order

7. **Dashboard.** List/search/edit/delete/bulk/undo, timeline (`valid_from`/`valid_until`), access log, stats, privacy controls (redaction preview, delete-everything), import/export UI — served from the daemon at `/ui`, live-updating via the existing `notifications/resources/updated` event bus (already built for M6/cross-client).
8. ~~Privacy~~ — done.
9. **Recall hook.** A Claude Code `SessionStart` hook that calls `get_context` and injects a budgeted (~800-token) ranked index, plus the system-prompt snippet and MCP prompts from §8 of the brief. Nothing in the tree does this yet.
10. **Portability.** `export_memories`/`import_memories` as the 7th tool pair (ZIP + SHA256 manifest), plus the Claude/ChatGPT memory importers that are the actual lock-in-escape hook (§1). Will need `src/mcp/server.test.ts`'s `tools.length` assertions bumped from 6 to 7 deliberately.
11. **Polish.** Hero GIF + demo GIF (needs M7 first, and a human — §7), README badges/FAQ, verify CI is actually green on all three OSes on GitHub (not just locally reproduced here), THIRD_PARTY_LICENSES.md kept current as dependencies are added.
