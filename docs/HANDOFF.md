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
| 7 | Dashboard | done — `691c69a`, `329b842`, `9a49164`, `9ea55ee`, `063d621` |
| 8 | Privacy (redaction, delete-everything) | done — `feat(privacy)` |
| 9 | Recall hook (Claude Code SessionStart) | done — `f58cb2a` |
| 10 | Portability (export/import, Claude/ChatGPT importers) | not started — no `export`/`import` tool, `export_memories`/`import_memories` not registered |
| 11 | Polish (README hero GIF, demo GIF, MIT LICENSE, CI 3 OSes) | partial — CI green on 3 OSes (last verified from this machine at `5b6a9f0`; not re-verified since — see §1's CI note), `LICENSE` (MIT) present; no hero/demo GIF, no `assets/` content beyond `.gitkeep` |

Nine milestones fully done, one partial, one not started. Portability (M10)
is the only substantial subsystem left — export/import plus the
Claude/ChatGPT importers that are the actual lock-in-escape hook (§1 of
`CLAUDE.md`). By line/effort weight the honest estimate is **roughly
85-90% of v1**: the two largest pieces (dashboard, recall hook) are both
in, and what remains is one milestone of real work (M10) plus polish
(M11) that needs a human for the GIFs and the package-name/publish
decisions already recorded in §7.

Current test count: **668 tests, 664 pass, 0 fail, 4 skipped** on the run
this document is based on (see §2). Repeated back-to-back `npm test` runs
in this session were not perfectly stable: one run reported 3 failures and
another reported 1, both in `src/shim/shim.test.ts`'s daemon-reconnect
test (`after the daemon dies mid-session, the shim recovers by
reconnecting or exits so the host can respawn it`); two other runs,
including the one quoted in §2, reported 0 failures. This is recorded
honestly rather than smoothed over — it looks like a timing-sensitive test,
not a corrupted tree (no other agent was touching this working directory
during these runs), but it has not been root-caused and should not be
assumed away.

MCP tool count is still **6**, not yet 7 — `export_memories`/
`import_memories` (M10) are not implemented, and
`assert.equal(tools.length, 6)` in `src/mcp/server.test.ts:187` and
`:211` will need updating, deliberately, when M10 lands.

CI (`.github/workflows/ci.yml`): matrix over `ubuntu-latest`, `macos-latest`,
`windows-latest`, `fail-fast: false`. Steps: `npm ci`, `npm run build`, a
`sqlite-vec` loadable-extension smoke check, then `npm test`. **CI status
has never been verified from this machine**: `gh` is not installed here
(`gh: command not found`) and the repository is private, so there is no way
from this box to query GitHub Actions. "CI is green" is therefore
unverified, not known — confirm it with `gh run list` on a machine that has
`gh` authenticated against this repo before trusting it.

## 2. How to run it — every command below was executed in this session

```
$ npm install
up to date, audited 100 packages in 1s
found 0 vulnerabilities

$ npm run build
> cairn@0.0.0 build
> tsc -p tsconfig.json && tsc -p tsconfig.ui.json && tsc -p tsconfig.uitest.json && node dist/scripts/copy-ui-assets.js

copy-ui-assets: copied 2 file(s) to /root/cairn/dist/dashboard/ui

real 0m15.8s

$ npm run typecheck
> cairn@0.0.0 typecheck
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.ui.json --noEmit && tsc -p tsconfig.uitest.json --noEmit
(no output; real 0m14.2s)

$ npm test          # runs: clean -> build -> node --test dist/**/*.test.js
...
1..668
# tests 668
# suites 0
# pass 664
# fail 0
# cancelled 0
# skipped 4
# todo 0
# duration_ms 26431.4
real 0m37.8s (this run) — see §1 for the flakiness observed across repeated runs
```

The build is now three `tsc` invocations plus one asset-copy step, not one:
`tsconfig.json` (Node-only root project), `tsconfig.ui.json` (the SPA, DOM
lib), `tsconfig.uitest.json` (the SPA's own unit tests), then
`copy-ui-assets.js` places the compiled UI's static files next to the
compiled JS the server serves them from. `npm run typecheck` now runs all
three `tsc -p ... --noEmit` invocations for the same reason recorded in
`9a49164`: it used to run only the root project and would report success
over a dashboard that did not compile.

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
  cairn hook session-start       print a Claude Code SessionStart hook envelope
                                  (see docs/RECALL_HOOK.md); never fails the session
  cairn help | --help | -h       show this help
  cairn --version                show the installed version

Note: bare "cairn" behaves differently depending on whether it is run from
a terminal (prints status) or launched by an MCP client (runs the shim) --
this is intentional, it is what makes the zero-config stdio client config
work. Use "cairn mcp" or "cairn status" to force one or the other.
```

`cairn hook session-start` (M9) is new since the last handoff — see
docs/RECALL_HOOK.md.

`cairn ui` now opens a real dashboard: the daemon serves the compiled SPA
at `/ui` (list/search/edit/delete/bulk/undo, timeline, access log, stats,
privacy panel), not a placeholder. Do not run bare `cairn setup`; see
§4/§6 and CONTRIBUTING.md.

## 3. The map

| Directory | What lives there | Depends on |
|---|---|---|
| `src/storage` | SQLite schema, migrations, WAL/concurrency, driver seam, repositories (memories, episodes, vectors, tags, audit, privacy-settings, stats) | `src/util` (ids, text hashing) |
| `src/embeddings` | `EmbeddingProvider` interface, ONNX (`local-onnx`), static fallback, `http` (Ollama/OpenAI/Voyage-shaped), factory/registry, background indexer worker | `src/storage` (writes vectors) |
| `src/retrieval` | FTS5 query, RRF fusion, recency/importance re-rank, MMR, `get_context` budget assembly | `src/storage`, `src/embeddings` |
| `src/mcp` | The tool surface (`tools.ts`), MCP server wiring, resources/notifications event bus (`events.ts`) | `src/retrieval`, `src/storage`, `src/privacy`, `src/config` (reserved dashboard client id) |
| `src/daemon` | HTTP+SSE server hosting the MCP server and the dashboard, shared HTTP primitives (`http.ts` — body cap, constant-time token check), runtime-file (port/pid/token) bookkeeping, lifecycle | `src/mcp`, `src/dashboard` |
| `src/dashboard` | `api.ts` — the `/api` surface (browse/search/edit/delete/bulk-undo, episodes, timeline, access log, connected-apps/pause, privacy panel, stats, SSE, `/api/context`); `assets.ts` — the static file server for the compiled SPA (path-traversal containment, extension allowlist, CSP); `ui/` — the SPA itself: `app.ts` (shell, hash routing), `dom.ts`, `state.ts`, `api-client.ts`, `views/memories.ts` | `src/storage`, `src/retrieval`, `src/mcp/events.ts` |
| `src/shim` | stdio-to-HTTP shim, daemon auto-start (`ensure-daemon.ts`) | `src/daemon` (spawns it) |
| `src/cli` | `cairn` entrypoint, arg parsing, command implementations (`status`/`start`/`stop`/`ui`/`embeddings`/`setup`/`hook`), daemon lifecycle helpers | `src/daemon`, `src/shim`, `src/setup` |
| `src/cli/hook.ts` | `cairn hook session-start` — fetches the budgeted context block from the local daemon and prints the Claude Code hook envelope; always exits 0, writes only the envelope (or nothing) to stdout | `src/daemon` (via HTTP), `src/config` |
| `src/setup` | Client detection + config writers for Claude Desktop / Claude Code / Cursor (`clients.ts`, `apply.ts`) | `src/config` (paths) |
| `src/config` | Path resolution (`CAIRN_HOME` vs. client config paths, which are deliberately outside it); `identity.ts` — `DASHBOARD_CLIENT`, the reserved dashboard client id shared between `src/dashboard` and `src/mcp` so neither has to import the other's module to read one string | — |
| `src/privacy` | Regex secret detectors, redaction (on/strict), `deleteEverything` | `src/storage` |
| `src/integration` | Cross-client end-to-end test + harness (spawns real CLI processes) | everything above |
| `src/util` | `uuidv7`/`timestampFromUuidv7`, text normalization/hashing | — |
| `src/testing` | Shared test helpers (temp dirs) | — |
| `src/scripts` | `smoke-vec.ts` (CI sqlite-vec loadable-extension check), `copy-ui-assets.ts` (places the SPA's compiled/static files next to the server that serves them) | `src/storage`, `src/dashboard/ui` |

Three `tsconfig`s compile three different things, and the split is
load-bearing, not tidy (`9a49164`):

- `tsconfig.json` — the root project. Node-only, no DOM lib, and it
  excludes `src/dashboard/ui`: without that exclude it would type-check
  browser code against Node-only types and fail outright.
- `tsconfig.ui.json` — compiles the SPA under `src/dashboard/ui` with the
  DOM lib and `"types": []`, which is what keeps browser code from
  reaching for Node globals (`process`, `require`, etc.).
- `tsconfig.uitest.json` — exists only because the SPA's own unit tests
  need `node:test`, which `"types": []` above forbids. A per-file
  `declare module` shim was tried first and broke the moment a second
  test file was added without it; a separate tsconfig for tests was the
  fix.

Top-level `/dashboard`, `/cli`, `/assets` are pre-scaffolded per BUILD_BRIEF
§13's intended repo layout but remain empty (`.gitkeep` only) — the actual
code is under `src/dashboard` and `src/cli`, not the top-level directories.

## 4. Invariants that are easy to break

- **Writes never call an LLM or touch the network.** `remember` only local-embeds (§2). `src/embeddings` API providers are opt-in and never on the default path.
- **Retrieval reads `memories_live`, never the base `memories` table.** The view filters soft-deleted and superseded rows; `src/storage/repositories/vectors.ts` and `memories.ts` join against it explicitly (see comments at `vectors.ts:269`, `memories.ts:94`). Querying `memories` directly will surface deleted/superseded rows in search. The dashboard's stats aggregates (`src/storage/repositories/stats.ts`) follow the same rule — only the deleted and superseded counts read the base `memories` table, correctly, because the view excludes those rows by definition.
- **`created_at` is derived from the id, never a second clock read.** `timestampFromUuidv7(id)` (`src/util/id.ts`) is the only source; `episodes.ts` and `memories.ts` both compute it this way so the row's timestamp can never disagree with its own id.
- **Integer parameters are normalised to `BigInt` at the driver seam**, documented in `src/storage/driver/types.ts` and `node-sqlite.ts:16` — an ordinary JS `number` bound where SQLite expects `INTEGER` is coerced to `BigInt` at that one boundary, not scattered through callers.
- **The tool ceiling is 6 today (design ceiling ≤7) and is asserted by a test** — `src/mcp/server.test.ts:187,211` (`assert.equal(tools.length, 6)`). A new tool added outside `export_memories`/`import_memories` should make you stop and re-read §6, not just bump the number.
- **`busy_timeout` must be armed before `PRAGMA journal_mode=WAL`, not after.** Reversing the order was measured at 18/40 two-process failures (`d934b79`); the order is now commented in `db.ts` as load-bearing.
- **The daemon listens on its port before it opens the database.** Only the kernel can arbitrate one thing cleanly — the port — so it decides first; opening the DB first let two racing daemons both start fighting over the file before either had lost (`d934b79`).
- **`cairn stop` (and the shim's attach path) require the daemon's own reported pid from `/health`, not just "pid exists + port answers."** A recycled pid can belong to an unrelated process; both call sites share the one predicate deliberately (`bd8f75b`).
- **`cairn setup` must never be run for real during verification** — always `--dry-run` or with `HOME`/`USERPROFILE` pointed at a temp directory. `CAIRN_HOME` does NOT isolate it: client config paths (`~/.claude.json`, `~/.cursor/mcp.json`, Claude Desktop's config path) are deliberately outside `CAIRN_HOME` (CONTRIBUTING.md).
- **A redaction finding never carries the secret it found.** Previews are masked; the raw value must appear in no table, including the FTS index (`5b6a9f0`). Do not "helpfully" log or return the matched string when touching `src/privacy`.
- **`npm test` must exit on its own — no `--test-force-exit`.** Anything a test or the code under test opens must be closed before the file's tests finish, or the process hangs; `src/shim/shim.test.ts` and `src/daemon/server.test.ts` close undici's global fetch dispatcher in `after()` for exactly this reason (CONTRIBUTING.md, `5945910`).
- **`/ui` routes off the raw request path, not the parsed `pathname`.** `new URL()` silently collapses `..` segments itself (`/ui/../../package.json` becomes `/package.json`), so routing off the WHATWG-normalized path would send every traversal attempt to the generic 404 branch instead of ever reaching `serveUiFile`'s containment check — the guard would be tested by its own unit test and nothing else. `src/daemon/server.ts` deliberately re-splits `req.url` for the `/ui` branch (`329b842`).
- **The dashboard must never be able to pause itself, and its client id is reserved.** `DASHBOARD_CLIENT` (`src/config/identity.ts`) is the id the dashboard stamps on its own store calls; the store's `gate()` refuses every gated call from a disabled client with no bypass, so if the dashboard's own id could be disabled, the very next request — including the one that would re-enable it — would be refused, locking the user out with no recovery short of hand-editing SQLite. `sourceClientName()` in `src/mcp/tools.ts` refuses to let any MCP client claim that name, so nothing can be impersonated into (or out of) the un-pauseable guard (`329b842`).
- **No CORS headers and no preflight handler, anywhere, ever.** `src/daemon/server.ts` requires an `Authorization` bearer token on `/api`, which is what forces a browser to send a CORS preflight it never answers — that absence is the actual boundary against a cross-origin page reading the store, not something to "fix" if a browser console complains (`329b842`).
- **`degradedReason` never leaves the process.** The retrieval layer sets it to the embedding provider's own `error.message`, which for an HTTP provider can carry a URL, hostname, or upstream error body. Both `/api/stats`-shaped routes and `/api/context` report a fixed `"embedding_failed"` string instead, through one shared helper, so the two call sites cannot drift apart (`063d621`). The `degraded` boolean itself is unchanged and safe to expose.
- **The SessionStart hook (`cairn hook session-start`, `src/cli/hook.ts`) always exits 0 and writes only the envelope to stdout.** For that hook, stdout *is* model context — a stray diagnostic line becomes something the model reads and may act on. No daemon, a refused connection, a 401, a 500, malformed JSON, or an unexpected throw all end the same way: exit 0, empty stdout, diagnostics (if any) to stderr. It also enforces its own ~2s deadline shared across draining stdin, the daemon check, and the fetch, rather than trusting whatever timeout the calling client happens to use (`f58cb2a`).

## 5. What this project has learned the hard way

- **Tests encoding the host OS.** A `C:\fake\home` literal is a relative path on POSIX; a `renameSync` onto a read-only file succeeds on POSIX (rename only needs directory write permission) but fails on Windows; a Windows-shaped client config marker landed where the POSIX detector never looks. Fix pattern each time: ask the code under test for the real path/behaviour instead of hardcoding a platform's own. Where a property is genuinely only measurable on one OS (open-fd counts via `/proc/self/fd`), skip elsewhere with `t.skip("reason")` (`2e1a4d6`, `14847fb`, CONTRIBUTING.md).
- **A security predicate duplicated in two places drifted.** The daemon-liveness/pid check was needed both by `cairn stop` and by the shim's attach-and-hand-over-the-token path; it now lives in one shared predicate rather than being reimplemented per call site (`bd8f75b`).
- **A test-runner flag silently dropped tests.** `--test-force-exit` masked a real hang, but on a slower CI runner it exited the process while a file still had queued subtests — 5 of `store.test.ts`'s tests vanished with no failure and no "cancelled" count. A green build that quietly ran less than it claimed is worse than a red one; the flag is gone and the actual hang (an unguarded module entrypoint) was fixed instead (`5945910`).
- **Killing a process by a recycled pid.** `cairn stop`'s old check ("pid exists" AND "port answers") could kill an unrelated process after a crash freed the pid for reuse; reproduced by killing a plain `node -e setInterval`. Fixed by requiring `/health` to return the daemon's own pid (`bd8f75b`).
- **A "finding" that carried the secret it reported.** Early redaction previews would have re-surfaced the very secret they existed to hide, in the dashboard and in error messages. Previews are masked now, and the test asserts the raw value is in no table at all, FTS included (`5b6a9f0`).
- **A review finding is not a fact until it is reproduced.** This session had two examples of a reported bug not surviving a check against the actual code: a regex a review called "dead" for supersede-collision detection was in fact matching (the store already throws a message the pattern catches; the fix in `9a49164` removed a real cross-module coupling but corrected no live defect) — and a review claim that the daemon's detached spawn inherits stdout and could leak startup output into the model's context turned out to be false, since `src/shim/ensure-daemon.ts` redirects both streams to `daemon.log` (`f58cb2a`). Both were reported as bugs before being checked against the code; the rule that follows is to read the implementation before writing the finding down, not after.
- **Concurrent agents in one working tree corrupt each other.** `npm test` begins with `npm run clean`, which deletes `dist/` outright — running it while another agent's build is mid-flight deletes that build's output out from under it. A `git stash` run for a before/after comparison reverted another agent's in-progress, uncommitted files. A broad `git add -A` swept a half-finished `src/cli/hook.ts` into an unrelated commit (`063d621`), which the following commit (`f58cb2a`) had to note and complete. The rule: one writer per file, no `npm test` while another agent is building, and no commit while an agent is running.

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
- **The demo/hero GIF.** BUILD_BRIEF §15 wants a hero GIF (Claude tells it something, Cursor recalls it) and a launch demo GIF (VHS/asciinema) — both need a human at a screen with a working dashboard. The dashboard exists now (M7 shipped), so this is unblocked except for the human and the screen.

## 8. What comes next, in BUILD_BRIEF §16 order

10. **Portability.** `export_memories`/`import_memories` as the 7th tool pair (ZIP + SHA256 manifest), plus the Claude/ChatGPT memory importers that are the actual lock-in-escape hook (§1). Will need `src/mcp/server.test.ts`'s `tools.length` assertions (`server.test.ts:187,211`) bumped from 6 to 7 deliberately.
11. **Polish.** Hero GIF + demo GIF (needs a human — §7), README badges/FAQ, verify CI is actually green on all three OSes on GitHub (not just locally reproduced here — see §1's CI note; `gh` is not installed on this machine). Two things found this session worth fixing here rather than deferring further:
    - `package.json` has no `files` field. `npm pack --dry-run` from this session lists 476 files in the tarball, including 45 `*.test.*` files and the full `src/` tree alongside `dist/` — the package currently ships its own test suite and source, and relies on undocumented npm default behaviour (rather than an explicit `files` allowlist) to include `dist` at all.
    - THIRD_PARTY_LICENSES.md kept current as dependencies are added.

## What is not verified

The dashboard SPA (`src/dashboard/ui`) has never been rendered in an
actual browser — no browser is available on this machine. Everything
claimed about it in this document and in the commit bodies it draws from
is verified by asset delivery (the static server tests), type checking
across all three `tsconfig`s, unit tests, and code review — not by
looking at it. `9a49164`'s commit body says this plainly and it is still
true.
