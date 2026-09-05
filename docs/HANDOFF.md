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
| 10 | Portability (export/import, Claude/ChatGPT importers) | done — a dependency-free ZIP codec (`196840d`), a manifest'd archive format with id-preserving import of both memories and episodes (`eadc98c`, `30f674b`, `55e016e`), `export_memories`/`import_memories` (`c1eca59`), the vendor importers wired to dashboard routes (`93fa972`) |
| 11 | Polish (README hero GIF, demo GIF, MIT LICENSE, CI 3 OSes) | partial — docs are current, CI is green on all three OSes (verified through `gh` on the two most recent runs), `LICENSE` (MIT) present; the hero and demo GIFs still need a human at a screen and are the only thing left |

Ten milestones fully done, one (polish) waiting only on the GIFs. By
line/effort weight the honest estimate — this is a judgement, not a
measurement — is **roughly 97-98% of v1**: every subsystem in the brief
exists, is wired end to end (export/import, the vendor importers, the
dashboard routes that call them), and CI has been read as green on all
three OSes rather than assumed. What is left is one human task (the GIFs)
and the two standing gaps recorded in §8.

Current test count: **799 tests, 795 pass, 0 fail, 4 skipped**. CI
(`.github/workflows/ci.yml`) has been read as green on Windows, macOS and
Ubuntu on the two most recent runs, verified through `gh run list`/`gh run
view` — not assumed. Getting there took four pushes that were red on the
runners while green locally; see §5, the flakiness this document used to
record in `src/shim/shim.test.ts`'s daemon-reconnect test was not the
issue found — the actual red runs were an `unzip -O` flag one Info-ZIP
build doesn't accept, a permission check invisible to root, and a real
product defect (files extracting at mode 000). None of those show up in a
run on this machine.

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
1..799
# tests 799
# suites 0
# pass 795
# fail 0
# cancelled 0
# skipped 4
# todo 0
# duration_ms 26431.4
real 0m37.8s (last full run recorded here; re-running costs ~90s — don't, unless something changed)
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
privacy panel, and now the pasted-memory and ChatGPT-custom-instructions
importers), not a placeholder. Do not run bare `cairn setup`; see
§4/§7 and CONTRIBUTING.md.

## 3. The map

| Directory | What lives there | Depends on |
|---|---|---|
| `src/storage` | SQLite schema, migrations, WAL/concurrency, driver seam, repositories (memories, episodes, vectors, tags, audit, privacy-settings, stats) | `src/util` (ids, text hashing) |
| `src/embeddings` | `EmbeddingProvider` interface, ONNX (`local-onnx`), static fallback, `http` (Ollama/OpenAI/Voyage-shaped), factory/registry, background indexer worker | `src/storage` (writes vectors) |
| `src/retrieval` | FTS5 query, RRF fusion, recency/importance re-rank, MMR, `get_context` budget assembly | `src/storage`, `src/embeddings` |
| `src/mcp` | The tool surface (`tools.ts`), MCP server wiring, resources/notifications event bus (`events.ts`) | `src/retrieval`, `src/storage`, `src/privacy`, `src/portability`, `src/config` (reserved dashboard client id) |
| `src/daemon` | HTTP+SSE server hosting the MCP server and the dashboard, shared HTTP primitives (`http.ts` — body cap, constant-time token check), runtime-file (port/pid/token) bookkeeping, lifecycle | `src/mcp`, `src/dashboard` |
| `src/dashboard` | `api.ts` — the `/api` surface (browse/search/edit/delete/bulk-undo, episodes, timeline, access log, connected-apps/pause, privacy panel, stats, SSE, `/api/context`, `/api/import/pasted`, `/api/import/chatgpt`); `assets.ts` — the static file server for the compiled SPA (path-traversal containment, extension allowlist, CSP); `ui/` — the SPA itself: `app.ts` (shell, hash routing), `dom.ts`, `state.ts`, `api-client.ts`, `views/memories.ts` | `src/storage`, `src/retrieval`, `src/mcp/events.ts`, `src/portability/importers` |
| `src/shim` | stdio-to-HTTP shim, daemon auto-start (`ensure-daemon.ts`) | `src/daemon` (spawns it) |
| `src/cli` | `cairn` entrypoint, arg parsing, command implementations (`status`/`start`/`stop`/`ui`/`embeddings`/`setup`/`hook`), daemon lifecycle helpers | `src/daemon`, `src/shim`, `src/setup` |
| `src/cli/hook.ts` | `cairn hook session-start` — fetches the budgeted context block from the local daemon and prints the Claude Code hook envelope; always exits 0, writes only the envelope (or nothing) to stdout | `src/daemon` (via HTTP), `src/config` |
| `src/setup` | Client detection + config writers for Claude Desktop / Claude Code / Cursor (`clients.ts`, `apply.ts`) | `src/config` (paths) |
| `src/config` | Path resolution (`CAIRN_HOME` vs. client config paths, which are deliberately outside it); `identity.ts` — `DASHBOARD_CLIENT`, the reserved dashboard client id shared between `src/dashboard` and `src/mcp` so neither has to import the other's module to read one string | — |
| `src/privacy` | Regex secret detectors, redaction (on/strict), `deleteEverything` | `src/storage` |
| `src/portability` | `zip.ts` — a dependency-free ZIP codec (stored/deflate, CRC-32, central directory); `archive.ts` — the export/import archive format (manifest.json + memories.jsonl + episodes.jsonl + README.txt, SHA256-verified both directions); `importers/` — `pasted.ts` (one memory per copy-pasted line, for Claude/ChatGPT's own settings UI, the only export surface either vendor actually offers) and `chatgpt.ts` (custom instructions out of a real `conversations.json` export) | `src/storage` |
| `src/integration` | Cross-client end-to-end test + harness (spawns real CLI processes) | everything above |
| `src/util` | `uuidv7`/`timestampFromUuidv7`, text normalization/hashing | — |
| `src/testing` | Shared test helpers (temp dirs) | — |
| `src/scripts` | `smoke-vec.ts` (CI sqlite-vec loadable-extension check), `copy-ui-assets.ts` (places the SPA's compiled/static files next to the server that serves them), `verify-package.ts` (asserts the published tarball has the bin entrypoint and all dashboard assets, and ships no test artifact or `src/`) | `src/storage`, `src/dashboard/ui` |

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
- **`created_at` is derived from the id, never a second clock read.** `timestampFromUuidv7(id)` (`src/util/id.ts`) is the only source; `episodes.ts` and `memories.ts` both compute it this way so the row's timestamp can never disagree with its own id. Import (`src/storage`, `src/portability/archive.ts`) inserts under the archive's own id for exactly this reason — a fresh id on import would collapse every imported memory's creation time to the moment of import.
- **Integer parameters are normalised to `BigInt` at the driver seam**, documented in `src/storage/driver/types.ts` and `node-sqlite.ts:16` — an ordinary JS `number` bound where SQLite expects `INTEGER` is coerced to `BigInt` at that one boundary, not scattered through callers.
- **The tool count is 8, not the old 6, and both the design ceiling and the tests that pin the number are load-bearing.** §6 lists `export_memories`/`import_memories` as one line item joined by a slash, but they were split into two tools rather than one with a `direction` flag, because a direction parameter on something that writes into a user's memory store is exactly the ambiguity that makes a model mis-fire (`c1eca59`). §2's ceiling is "≤ ~7"; eight is a deliberate, recorded step past it, not drift. `src/mcp/server.test.ts:206,243` and `src/daemon/server.test.ts:177` all assert `tools.length === 8` — changing one without the other fails loudly rather than silently disagreeing.
- **`busy_timeout` must be armed before `PRAGMA journal_mode=WAL`, not after.** Reversing the order was measured at 18/40 two-process failures (`d934b79`); the order is now commented in `db.ts` as load-bearing.
- **The daemon listens on its port before it opens the database.** Only the kernel can arbitrate one thing cleanly — the port — so it decides first; opening the DB first let two racing daemons both start fighting over the file before either had lost (`d934b79`).
- **`cairn stop` (and the shim's attach path) require the daemon's own reported pid from `/health`, not just "pid exists + port answers."** A recycled pid can belong to an unrelated process; both call sites share the one predicate deliberately (`bd8f75b`).
- **`cairn setup` must never be run for real during verification** — always `--dry-run` or with `HOME`/`USERPROFILE` pointed at a temp directory. `CAIRN_HOME` does NOT isolate it: client config paths (`~/.claude.json`, `~/.cursor/mcp.json`, Claude Desktop's config path) are deliberately outside `CAIRN_HOME` (CONTRIBUTING.md).
- **A redaction finding never carries the secret it found.** Previews are masked; the raw value must appear in no table, including the FTS index (`5b6a9f0`). Do not "helpfully" log or return the matched string when touching `src/privacy`.
- **`npm test` must exit on its own — no `--test-force-exit`.** Anything a test or the code under test opens must be closed before the file's tests finish, or the process hangs; `src/shim/shim.test.ts`, `src/daemon/server.test.ts` and now `src/cli/commands.test.ts` close undici's global fetch dispatcher in `after()` for exactly this reason (CONTRIBUTING.md, `5945910`, `196840d`).
- **`/ui` routes off the raw request path, not the parsed `pathname`.** `new URL()` silently collapses `..` segments itself (`/ui/../../package.json` becomes `/package.json`), so routing off the WHATWG-normalized path would send every traversal attempt to the generic 404 branch instead of ever reaching `serveUiFile`'s containment check — the guard would be tested by its own unit test and nothing else. `src/daemon/server.ts` deliberately re-splits `req.url` for the `/ui` branch (`329b842`).
- **The dashboard must never be able to pause itself, and its client id is reserved.** `DASHBOARD_CLIENT` (`src/config/identity.ts`) is the id the dashboard stamps on its own store calls; the store's `gate()` refuses every gated call from a disabled client with no bypass, so if the dashboard's own id could be disabled, the very next request — including the one that would re-enable it — would be refused, locking the user out with no recovery short of hand-editing SQLite. `sourceClientName()` in `src/mcp/tools.ts` refuses to let any MCP client claim that name, so nothing can be impersonated into (or out of) the un-pauseable guard (`329b842`).
- **No CORS headers and no preflight handler, anywhere, ever.** `src/daemon/server.ts` requires an `Authorization` bearer token on `/api`, which is what forces a browser to send a CORS preflight it never answers — that absence is the actual boundary against a cross-origin page reading the store, not something to "fix" if a browser console complains (`329b842`).
- **`degradedReason` never leaves the process.** The retrieval layer sets it to the embedding provider's own `error.message`, which for an HTTP provider can carry a URL, hostname, or upstream error body. Both `/api/stats`-shaped routes and `/api/context` report a fixed `"embedding_failed"` string instead, through one shared helper, so the two call sites cannot drift apart (`063d621`). The `degraded` boolean itself is unchanged and safe to expose.
- **The SessionStart hook (`cairn hook session-start`, `src/cli/hook.ts`) always exits 0 and writes only the envelope to stdout.** For that hook, stdout *is* model context — a stray diagnostic line becomes something the model reads and may act on. No daemon, a refused connection, a 401, a 500, malformed JSON, or an unexpected throw all end the same way: exit 0, empty stdout, diagnostics (if any) to stderr. It also enforces its own ~2s deadline shared across draining stdin, the daemon check, and the fetch, rather than trusting whatever timeout the calling client happens to use (`f58cb2a`).
- **`export_memories` writes with `wx` and refuses the daemon's own files by name.** Confining writes to the Cairn home was a real fix, but the database — and its `-wal`/`-shm` and runtime files — live in that same home, so a path like `cairn.db` passed the containment check and `writeFileSync` truncated the live database to a ZIP (measured: 667648 bytes to 27641, "file is not a database" on next open). Two guards now: `flag: "wx"` so no existing file is ever clobbered regardless of name, and an explicit refusal of the daemon's own filenames, which also covers the window before a fresh home has written its runtime file yet (`e6fa952`).
- **Import runs in one transaction, episodes and memories together.** Each insert used to run in its own implicit transaction, so a checksum-valid archive containing one row the store rejects — an out-of-range importance, an in-scope text collision, a missing episodeId — left the store permanently half-imported with no record of where it stopped. The tampered-archive test only passed by luck, because the SHA256 gate runs before any insert. One transaction now covers the whole loop, so a failure anywhere rolls back both layers (`0085bd2`).
- **An archive entry is capped at an absolute 64 MiB, not a derived one.** The first version of the cap was `MAX_LINES * MAX_LINE_BYTES`, about 6.5 GB — it bounded nothing, since the OOM it existed to stop came from a 410 KB archive (splitLines decoded and split("\n") before consulting the line cap; a 512 KB archive killed the daemon with a V8 heap fatal). The cap is now a plain absolute ceiling on a decompressed entry, checked before any decoding (`e6fa952`, `1963819`).
- **The ZIP's external attributes must carry a Unix file mode whenever "version made by" claims Unix provenance.** `writeZip` sets that high byte to Unix deliberately, so Info-ZIP honours the UTF-8 filename flag instead of mis-decoding non-ASCII names as CP437 — but the same claim makes unzip read the high 16 bits of the external attributes as the file's mode, and an export that left those zero extracted every file at mode 000. The two fields have to move together; the constant says so next to the version-made-by value (`4dde341`).
- **`verify-package` must run through `npm run` (or otherwise inherit `npm_execpath`) so it can resolve `npm` portably.** `execFile('npm', ...)` fails with `ENOENT` on Windows because `npm` there is `npm.cmd` and `execFile` does not consult `PATHEXT` the way a shell does. The check resolves npm's own JS entrypoint via `npm_execpath` and runs it through the current Node binary instead (`c47f9ca`).

## 5. What this project has learned the hard way

- **Green locally is not green.** Four commits in the portability milestone were pushed red on CI while every local run passed: an `unzip -O` flag that only this machine's Info-ZIP build accepts (`55e016e`), and a file-permission check that is invisible to a process running as root (`4dde341`) — both real bugs no local run here could see, plus a genuine product defect (files extracting at mode 000, the same commit). Installing `gh` and reading the actual run, rather than trusting a local pass, is what found all three.
- **A review finding is not a fact until it is reproduced.** Several findings relayed as bugs in this session did not survive being checked against the actual code before that check happened — two examples logged in this document's earlier revision (a "dead" regex that was in fact matching, a claimed stdout leak that a redirect already prevented) — and the rule stands: read the implementation before writing the finding down, not after.
- **Do not commit while an agent is still writing.** It happened five times in this session and pushed non-compiling code to `main` twice (`063d621`'s `src/cli/commands.ts` missing a return statement; a later commit shipped `src/mcp/server.test.ts` mid-write with a `TS2554` compile error). The remedy that actually works is mechanical, not a reminder to be careful: snapshot `git diff HEAD | md5sum` before and after the test run and refuse to commit if it moved. That guard caught the fifth attempt before it landed (`1963819`).
- **Tests encoding the host OS.** A `C:\fake\home` literal is a relative path on POSIX; a `renameSync` onto a read-only file succeeds on POSIX (rename only needs directory write permission) but fails on Windows; a Windows-shaped client config marker landed where the POSIX detector never looks. Fix pattern each time: ask the code under test for the real path/behaviour instead of hardcoding a platform's own. Where a property is genuinely only measurable on one OS (open-fd counts via `/proc/self/fd`), skip elsewhere with `t.skip("reason")` (`2e1a4d6`, `14847fb`, CONTRIBUTING.md).
- **A security predicate duplicated in two places drifted.** The daemon-liveness/pid check was needed both by `cairn stop` and by the shim's attach-and-hand-over-the-token path; it now lives in one shared predicate rather than being reimplemented per call site (`bd8f75b`).
- **A test-runner flag silently dropped tests.** `--test-force-exit` masked a real hang, but on a slower CI runner it exited the process while a file still had queued subtests — 5 of `store.test.ts`'s tests vanished with no failure and no "cancelled" count. A green build that quietly ran less than it claimed is worse than a red one; the flag is gone and the actual hang (an unguarded module entrypoint) was fixed instead (`5945910`).
- **Killing a process by a recycled pid.** `cairn stop`'s old check ("pid exists" AND "port answers") could kill an unrelated process after a crash freed the pid for reuse; reproduced by killing a plain `node -e setInterval`. Fixed by requiring `/health` to return the daemon's own pid (`bd8f75b`).
- **A "finding" that carried the secret it reported.** Early redaction previews would have re-surfaced the very secret they existed to hide, in the dashboard and in error messages. Previews are masked now, and the test asserts the raw value is in no table at all, FTS included (`5b6a9f0`).
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
- **Green output is not evidence on its own.** The `--test-force-exit` incident (§5) is the canonical example: the suite reported success while quietly running fewer tests than it claimed. The milestone-10 CI incidents (§5) are the same lesson from the other direction: a local pass is not evidence either, and `gh` is what actually settles it.

## 7. Open decisions that belong to the human

- **The package name.** BUILD_BRIEF §0 flags `cairn` as a placeholder pending npm-name / GitHub-org / `.dev`-domain / trademark verification, with `Marrow` and `Loam` as fallbacks (possible suffix: `cairn-mcp`, `usecairn`). `package.json` currently says `"name": "cairn"`. This needs a human to actually check availability before publish.
- **Publishing.** `package.json` is publishable as of 0.1.0 (no `"private"` key), but `cairn setup` (`src/setup/apply.ts`, `src/cli/commands.ts`, `src/cli/index.ts`) writes `npx -y cairn@latest` into every client config it generates. That line will not work for any real user until the package is actually published under whatever name §0 settles on — what blocks publication is the unresolved package name above, not the `private` flag — a human decision (npm account, publish flow), not an agent one.
- **The demo/hero GIF.** BUILD_BRIEF §15 wants a hero GIF (Claude tells it something, Cursor recalls it) and a launch demo GIF (VHS/asciinema) — both need a human at a screen with a working dashboard. The dashboard exists now (M7 shipped) and the vendor importers are reachable from it (M10 shipped), so this is unblocked except for the human and the screen.

## 8. What comes next

Milestone 11's GIFs (§7) are the only remaining scheduled work. One
standing gap remains open; the other, recorded here for a while, is now
closed:

- **CLOSED 2026-09-05: the dashboard SPA had never been rendered in an
  actual browser.** The daemon was started on this machine, the store was
  seeded with real data (14 live memories across 3 scopes, a superseded
  Munich→Berlin pair, a soft-deleted memory, a redacted AWS key, 15
  episodes), and the project owner opened `http://localhost:8787/ui`
  through an SSH tunnel and reviewed it by hand — verdict: it looks good,
  and all 12 UI assets served with correct content types. That establishes
  human review of the rendered SPA; it does not establish automated
  browser/end-to-end test coverage, which still does not exist.
- **The Claude/ChatGPT vendor importers have never been run against a
  real export.** `c2687d1`'s test fixtures for both formats are built
  from documented and community-reported shapes, not a real Claude
  memory paste or a real ChatGPT `conversations.json` — the parsers are
  wired and tested against constructed input, but unvalidated against
  reality.

`package.json` has no `files`-shaped concern left open (`edb359c`,
`c47f9ca`, `0085bd2` closed that loop and `verify-package` now guards it in
CI), and THIRD_PARTY_LICENSES.md is current as of the last dependency
added.
