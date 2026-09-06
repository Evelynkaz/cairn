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
| 3 | Retrieval | done — `feat(retrieval)`, hardened by `3877a54` (see §1a) |
| 4 | MCP server + stdio shim + daemon auto-start | done — `feat(mcp)` |
| 5 | CLI (`cairn`, `cairn setup`, `cairn ui`) | done — `feat(cli)` |
| 6 | Cross-client integration test | done — `feat(integration)` |
| 7 | Dashboard | done — six sections rendered and screenshotted (`691c69a`, `329b842`, `9a49164`, `9ea55ee`, `063d621`, `1b7ae7d`); no automated browser test |
| 8 | Privacy (redaction, delete-everything) | done — `feat(privacy)`, hardened by `f4dd3c9` and `6d08e56` (see §1a) |
| 9 | Recall hook (Claude Code SessionStart) | done — `f58cb2a`, provenance-gated by `27d5b03` (see §1a) |
| 10 | Portability (export/import, Claude/ChatGPT importers) | done — a dependency-free ZIP codec (`196840d`), a manifest'd archive format with id-preserving import of both memories and episodes (`eadc98c`, `30f674b`, `55e016e`), `export_memories`/`import_memories` (`c1eca59`), the vendor importers wired to dashboard routes (`93fa972`, `1b7ae7d`); never run against a real vendor export (§8) |
| 11 | Polish (README hero GIF, demo GIF, MIT LICENSE, CI 3 OSes) | blocked — package renamed and published-ready (`114cd47`), screenshots exist, but **CI is not running at all right now** (§1b) and the GIFs still need a human at a screen |

The package is published-ready and every subsystem in the brief is wired
end to end, but call this "done" only with the CI and audit caveats below
attached — the last stretch of this project was six independent security
reviews finding nineteen criticals in a suite that was fully green at the
time, and the fixes for those in turn needed a rework pass of their own. Read
§1a before touching `src/privacy`, `src/retrieval`, `src/daemon`, or
`src/portability`.

Current test count: **1005 tests, 999 pass, 0 fail, 6 skipped**, verified
locally on Linux (`27d5b03`). This project has been burned twice on
trusting a raw pass/skip count without reading what changed it (§5) — the
6th skip (up from 5) is a new `ensureHome` test added in `27d5b03` that
skips under `process.getuid?.() === 0`, per CONTRIBUTING.md's root-skip
rule; this session runs as root (`id -u` is `0`), so it is expected here,
not a new gap.

This paragraph is a snapshot, not a promise: it will drift again the next
time a commit changes the count. §2 no longer pastes the `node --test`
summary for the same reason — run `npm test` yourself rather than trusting
a transcript that looks current and isn't.

### 1a. The security audits and the rework — read this before touching privacy, retrieval, the daemon, or portability

Six independent audits ran against a tree that reported 799 green tests
and found nineteen criticals none of those tests caught. They cluster
into four repeatable patterns, which is the actual lesson — not the list
of bugs:

- **Redaction stood at one ingest point while the store had five.**
  `redactText` ran only in `remember()`; `update_memory`, `supersede`,
  import, and (found only in the rework pass) `episodes.metadata` all
  wrote raw text straight past it (`f4dd3c9`, `6d08e56`).
- **Ranking mixed incomparable scales and silently returned wrong
  answers.** Relevance divided by its own call's max sat on a different
  scale than recency; importance could never reach outside a
  recency-bounded pool; the vector branch had no absolute distance floor
  — none of this crashes or logs, it just returns the wrong memories,
  which for a memory system is the worst failure mode there is (`3877a54`).
- **Checks covered entry but not continuation.** A 4 MB body cap applied
  only to the MCP handshake, not the session after it; a restrictive file
  mode applied only at file creation, not to a file an attacker
  pre-created; a containment check compared paths lexically instead of by
  realpath, so a symlinked parent directory walked straight out of it
  (`601e7d8`, `3e272af`).
- **A check trusted the thing it was checking.** `cairn stop` used to
  trust a process's own claimed liveness; import used to trust an
  archive's own `redacted: true` flag — an attacker-controlled file
  simply sets it (`f4dd3c9`).

**The fixes for these then introduced six more defects, two of them worse
than what they replaced** (`6d08e56`): a new `.env` detector destroyed 7
of 10 realistic notes irreversibly (redaction rewrites the episode, so
the user's own words were gone for good), and the ranking fix's min-max
normalisation pinned the worst candidate to exactly 0 for every corpus
size, so the relevance floor silently dropped real results — five
matching memories came back as four.

**How the dropped-result bug got past review is the important part.**
Landing that ranking fix broke nine pre-existing tests. Each one was
individually given `minRelevance: 0` with a plausible-sounding
justification, and each justification was accepted on its own terms.
Nine tests failing to one change is not nine cases to explain
separately — it is one signal, repeated nine times, and it should have
been read as one question ("did the fix change what counts as a match?")
before any test was touched.

### 1b. CI is not running — nothing since `114cd47` is verified on Windows or macOS

Since 19:05 today every GitHub Actions run on this repo fails in about
ten seconds with: *"The job was not started because recent account
payments have failed or your spending limit needs to be increased."*
Three consecutive pushes (`3877a54`, `5963277`, `6d08e56`) have failed
this way — `gh run list` shows it plainly, and it is a billing problem on
the owner's account, not a code or workflow regression. It is blocked on
the owner (§8); do not try to work around it, and do not assume the
retrieval fix, the rework, or the refactor are cross-platform clean just
because they pass here.

**What this means concretely: nothing landed since `114cd47` has been
verified on Windows or macOS.** This project has hit real
Windows/macOS-only bugs before that no Linux run could see (§5) — treat
that risk as live, not historical, until CI billing is fixed and a run
goes green on all three OSes again.

**What WAS verified by hand on this Linux machine**, and is real evidence
even though it is not the three-OS matrix: the full 971-test suite;
`npm run typecheck` across all three `tsconfig` projects; `verify-package`
against 162 packaged files; `npm pack` followed by installing the tarball
outside this repo, running the installed CLI, starting the packed
daemon, getting a 200 from `/health`, and stopping it; and
`npm publish --dry-run` succeeding end to end. None of that substitutes
for the Windows/macOS legs — it rules out a broken package, not a
platform-specific bug.

### 1c. `27d5b03` — provenance, and a hand audit standing in for the CI this project doesn't have

Two bodies of work landed together. First, provenance: memories now carry
`origin` (`user` / `import` / `unknown`) and `approved`; the SessionStart
hook injects only user-originated or approved memories (§1a, §4); the
`get_context` tool still returns imported memories but labels them instead
of excluding them, because a model that asks for context deliberately can
weigh that itself. Rows written before this migration are `unknown`, not
back-filled as `user` — **an existing store's SessionStart block goes empty
until its memories are approved in the dashboard**, which is a real
upgrade surprise, recorded in CHANGELOG.md's Unreleased section on purpose.

Second, since CI still cannot run (§1b), an audit was done by hand as its
substitute and found that the day's own security work had broken macOS
outright (`export_memories`'s symlink guard compared a realpath'd
directory against a home that was never realpath'd, and macOS's `/var` is
a symlink) plus Windows reserved-device-name bypasses, two unguarded
`fchmodSync` calls, and a test that would have hung six hours rather than
failed. All are fixed on this branch; **none of it is verified on real
Windows or macOS hardware** — §1b still applies, this was found and fixed
by reading and reproducing on Linux, not by running the actual platform.

```
$ npm install
up to date, audited 100 packages in 1s
found 0 vulnerabilities

$ npm run build
> cairn@0.1.0 build
> tsc -p tsconfig.json && tsc -p tsconfig.ui.json && tsc -p tsconfig.uitest.json && node dist/scripts/copy-ui-assets.js

copy-ui-assets: copied 2 file(s) to /root/cairn/dist/dashboard/ui

real 0m15.8s

$ npm run typecheck
> cairn@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.ui.json --noEmit && tsc -p tsconfig.uitest.json --noEmit
(no output; three projects, all clean)

$ npm test          # runs: clean -> build -> node --test dist/**/*.test.js
```

The exact `node --test` summary (tests/pass/fail/skipped counts) is
deliberately not pasted here anymore. It drifted five times in one day —
every count in this document is a snapshot of one commit, not a live
value, and a transcript that looks like a terminal invites trust a stale
number hasn't earned. Run `npm test` yourself; when this line was written it was 1005
tests, 999 pass, 0 fail, 6 skipped (see §1).

The build is still three `tsc` invocations plus one asset-copy step, not
one: `tsconfig.json` (Node-only root project), `tsconfig.ui.json` (the
SPA, DOM lib), `tsconfig.uitest.json` (the SPA's own unit tests), then
`copy-ui-assets.js` places the compiled UI's static files next to the
compiled JS the server serves them from. `npm run typecheck` runs all
three `tsc -p ... --noEmit` invocations for the reason recorded in
`9a49164`: it used to run only the root project and would report success
over a dashboard that did not compile.

Beyond the suite, three checks were run and are worth re-running before
any release rather than trusting they still hold: `verify-package`
(`node --test` covers it, but it is also runnable standalone — asserts
the tarball has the bin entrypoint, all twelve dashboard assets, and
ships no test artifact or `src/`), `npm pack` + install the tarball
outside the repo + run the installed CLI + start the packed daemon +
confirm `/health` is 200 + stop it, and `npm publish --dry-run`. All
three passed locally today; none of them is a substitute for the CI
matrix that is currently down (§1b).

```
$ node dist/cli/index.js --help
cairn -- local-first memory MCP server

Usage:
  cairn                          run as the stdio MCP shim when not on a
                                  terminal (this is what an MCP client's
                                  {"command":"npx","args":["-y","cairn-mem@latest"]}
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

`cairn hook session-start` (M9) prints a Claude Code SessionStart hook
envelope — see docs/RECALL_HOOK.md.

`cairn ui` opens a real dashboard now, with all six nav sections
implemented (memories, timeline, access log, connected apps, privacy,
stats) rather than the "coming in the next step" placeholder five of them
carried before `1b7ae7d`: list/search/edit/delete/bulk/undo, a Supersede
row action on Memories, an Import panel for both vendor importers, plus
timeline, access log, and stats views. It has been rendered in an actual
browser, seeded with real data, and reviewed by the project owner over an
SSH tunnel (§8) — the five screenshots from that session live in
`assets/` (`hero.png`, `timeline.png`, `access-log.png`, `privacy.png`,
`stats.png`). There is still **no automated browser test** — the mount
closures are deliberately untested beyond the pure helpers they call;
see §8. Do not run bare `cairn setup`; see §4/§7 and CONTRIBUTING.md.

## 3. The map

| Directory | What lives there | Depends on |
|---|---|---|
| `src/storage` | SQLite schema, migrations, WAL/concurrency, driver seam, repositories (memories, episodes, vectors, tags, audit, privacy-settings, stats), `limits.ts` — the one home for input caps shared with `src/dashboard/api.ts` (`5963277`) | `src/util` (ids, text hashing) |
| `src/embeddings` | `EmbeddingProvider` interface, ONNX (`local-onnx`), static fallback, `http` (Ollama/OpenAI/Voyage-shaped), factory/registry, background indexer worker | `src/storage` (writes vectors) |
| `src/retrieval` | FTS5 query, RRF fusion, recency/importance re-rank, MMR, `get_context` budget assembly — the ranking scale/threshold split from `6d08e56` lives here | `src/storage`, `src/embeddings` |
| `src/mcp` | The tool surface (`tools.ts`), MCP server wiring, resources/notifications event bus (`events.ts`), `withBoundedErrors` applied at registration to every handler including the resource mirror (`3e272af`, `6d08e56`) | `src/retrieval`, `src/storage`, `src/privacy`, `src/portability`, `src/config` (reserved dashboard client id) |
| `src/daemon` | HTTP+SSE server hosting the MCP server and the dashboard, shared HTTP primitives (`http.ts` — body cap enforced on the full session not just the handshake, constant-time token check), runtime-file (port/pid/token) bookkeeping, lifecycle | `src/mcp`, `src/dashboard` |
| `src/dashboard` | `api.ts` — the `/api` surface (browse/search/edit/delete/bulk-undo, episodes, timeline, access log, connected-apps/pause, privacy panel, stats, SSE, `/api/context`, `/api/import/pasted`, `/api/import/chatgpt`); `assets.ts` — the static file server for the compiled SPA (path-traversal containment, extension allowlist, CSP); `ui/` — the SPA itself: `app.ts` (shell, hash routing over all six sections via a `Record<SectionId, ...>`), `dom.ts`, `state.ts`, `api-client.ts`, `views/` (memories, timeline, access-log, connected-apps, privacy, stats) | `src/storage`, `src/retrieval`, `src/mcp/events.ts`, `src/portability/importers` |
| `src/shim` | stdio-to-HTTP shim, daemon auto-start (`ensure-daemon.ts`) | `src/daemon` (spawns it) |
| `src/cli` | `cairn` entrypoint, arg parsing, command implementations (`status`/`start`/`stop`/`ui`/`embeddings`/`setup`/`hook`), daemon lifecycle helpers | `src/daemon`, `src/shim`, `src/setup` |
| `src/cli/hook.ts` | `cairn hook session-start` — fetches the budgeted context block from the local daemon and prints the Claude Code hook envelope; always exits 0, writes only the envelope (or nothing) to stdout | `src/daemon` (via HTTP), `src/config` |
| `src/setup` | Client detection + config writers for Claude Desktop / Claude Code / Cursor (`clients.ts`, `apply.ts`); writes `npx -y cairn-mem@latest` into every generated config | `src/config` (paths) |
| `src/config` | Path resolution (`CAIRN_HOME` vs. client config paths, which are deliberately outside it); `identity.ts` — `DASHBOARD_CLIENT`, the reserved dashboard client id shared between `src/dashboard` and `src/mcp` so neither has to import the other's module to read one string | — |
| `src/privacy` | Regex secret detectors, redaction (on/strict), `deleteEverything` — now the single chokepoint for all five ingest paths (`f4dd3c9`, `6d08e56`) | `src/storage` |
| `src/portability` | `zip.ts` — a dependency-free ZIP codec (stored/deflate, CRC-32, central directory); `archive.ts` — the export/import archive format (manifest.json + memories.jsonl + episodes.jsonl + README.txt, SHA256-verified both directions); `importers/` — `pasted.ts` (one memory per copy-pasted line, for Claude/ChatGPT's own settings UI, the only export surface either vendor actually offers) and `chatgpt.ts` (custom instructions out of a real `conversations.json` export) — parsers are tested against constructed fixtures only, never a real vendor export (§8) | `src/storage` |
| `src/integration` | Cross-client end-to-end test + harness (spawns real CLI processes); locates the repo root by `pkg.name === "cairn-mem"` since the rename | everything above |
| `src/util` | `uuidv7`/`timestampFromUuidv7`, text normalization/hashing | — |
| `src/testing` | Shared test helpers (temp dirs) | — |
| `src/scripts` | `smoke-vec.ts` (CI sqlite-vec loadable-extension check), `copy-ui-assets.ts` (places the SPA's compiled/static files next to the server that serves them), `verify-package.ts` (asserts the published tarball has the bin entrypoint and all twelve dashboard assets, and ships no test artifact or `src/`) | `src/storage`, `src/dashboard/ui` |

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

Top-level `/dashboard`, `/cli`, `/assets` were pre-scaffolded per
BUILD_BRIEF §13's intended repo layout; `assets/` is no longer empty (it
now holds the five dashboard screenshots, §2), but `/dashboard` and
`/cli` remain `.gitkeep`-only — the actual code is under `src/dashboard`
and `src/cli`.

## 4. Invariants that are easy to break

- **Writes never call an LLM or touch the network.** `remember` only local-embeds (§2). `src/embeddings` API providers are opt-in and never on the default path.
- **Retrieval reads `memories_live`, never the base `memories` table.** The view filters soft-deleted and superseded rows; `src/storage/repositories/vectors.ts` and `memories.ts` join against it explicitly (see comments at `vectors.ts:269`, `memories.ts:94`). Querying `memories` directly will surface deleted/superseded rows in search. The dashboard's stats aggregates (`src/storage/repositories/stats.ts`) follow the same rule — only the deleted and superseded counts read the base `memories` table, correctly, because the view excludes those rows by definition.
- **`created_at` is derived from the id, never a second clock read.** `timestampFromUuidv7(id)` (`src/util/id.ts`) is the only source; `episodes.ts` and `memories.ts` both compute it this way so the row's timestamp can never disagree with its own id. Import (`src/storage`, `src/portability/archive.ts`) inserts under the archive's own id for exactly this reason — a fresh id on import would collapse every imported memory's creation time to the moment of import.
- **Integer parameters are normalised to `BigInt` at the driver seam**, documented in `src/storage/driver/types.ts` and `node-sqlite.ts:16` — an ordinary JS `number` bound where SQLite expects `INTEGER` is coerced to `BigInt` at that one boundary, not scattered through callers.
- **The tool count is 8, not the old 6, and both the design ceiling and the tests that pin the number are load-bearing.** §6 lists `export_memories`/`import_memories` as one line item joined by a slash, but they were split into two tools rather than one with a `direction` flag, because a direction parameter on something that writes into a user's memory store is exactly the ambiguity that makes a model mis-fire (`c1eca59`). §2's ceiling is "≤ ~7"; eight is a deliberate, recorded step past it, not drift. `src/mcp/server.test.ts:206,243` and `src/daemon/server.test.ts:177` all assert `tools.length === 8` — changing one without the other fails loudly rather than silently disagreeing.
- **`busy_timeout` must be armed before `PRAGMA journal_mode=WAL`, not after.** Reversing the order was measured at 18/40 two-process failures (`d934b79`); the order is now commented in `db.ts` as load-bearing.
- **The daemon listens on its port before it opens the database.** Only the kernel can arbitrate one thing cleanly — the port — so it decides first; opening the DB first let two racing daemons both start fighting over the file before either had lost (`d934b79`).
- **`cairn stop` (and the shim's attach path) require the daemon's own reported pid from `/health`, not just "pid exists + port answers."** A recycled pid can belong to an unrelated process; both call sites share the one predicate deliberately (`bd8f75b`). This is the general pattern behind §1a's "a check trusted the thing it checked" — don't let a component vouch for itself when an outside signal (the kernel's port, the archive's own hash) is available instead.
- **`cairn setup` must never be run for real during verification** — always `--dry-run` or with `HOME`/`USERPROFILE` pointed at a temp directory. `CAIRN_HOME` does NOT isolate it: client config paths (`~/.claude.json`, `~/.cursor/mcp.json`, Claude Desktop's config path) are deliberately outside `CAIRN_HOME` (CONTRIBUTING.md).
- **A redaction finding never carries the secret it found.** Previews are masked with no trailing characters, entropy-prefixed kinds are masked entirely, and the raw value must appear in no table, including the FTS index and `episodes.metadata` (`5b6a9f0`, `f4dd3c9`, `6d08e56`). Do not "helpfully" log or return the matched string when touching `src/privacy`.
- **Redaction runs at every ingest path, not just `remember`.** `update_memory`, `supersede`, import, and `episodes.metadata` (fed by `remember`'s unbounded `source` parameter) all redact and enforce strict-mode refusal now, in the same transaction as the write. Import derives its own `redacted` flag rather than trusting the archive's (`f4dd3c9`). If you add a sixth way to write memory text into the store, it needs this too.
- **`npm test` must exit on its own — no `--test-force-exit`.** Anything a test or the code under test opens must be closed before the file's tests finish, or the process hangs; `src/shim/shim.test.ts`, `src/daemon/server.test.ts` and `src/cli/commands.test.ts` close undici's global fetch dispatcher in `after()` for exactly this reason (CONTRIBUTING.md, `5945910`, `196840d`).
- **`/ui` routes off the raw request path, not the parsed `pathname`.** `new URL()` silently collapses `..` segments itself (`/ui/../../package.json` becomes `/package.json`), so routing off the WHATWG-normalized path would send every traversal attempt to the generic 404 branch instead of ever reaching `serveUiFile`'s containment check — the guard would be tested by its own unit test and nothing else. `src/daemon/server.ts` deliberately re-splits `req.url` for the `/ui` branch (`329b842`).
- **The dashboard must never be able to pause itself, and its client id is reserved.** `DASHBOARD_CLIENT` (`src/config/identity.ts`) is the id the dashboard stamps on its own store calls; the store's `gate()` refuses every gated call from a disabled client with no bypass, so if the dashboard's own id could be disabled, the very next request — including the one that would re-enable it — would be refused, locking the user out with no recovery short of hand-editing SQLite. `sourceClientName()` in `src/mcp/tools.ts` refuses to let any MCP client claim that name, so nothing can be impersonated into (or out of) the un-pauseable guard (`329b842`).
- **No CORS headers and no preflight handler, anywhere, ever.** `src/daemon/server.ts` requires an `Authorization` bearer token on `/api`, which is what forces a browser to send a CORS preflight it never answers — that absence is the actual boundary against a cross-origin page reading the store, not something to "fix" if a browser console complains (`329b842`).
- **`degradedReason` never leaves the process.** `toSafeDegradedReason` now lives once, beside the `SearchResult.degradedReason` field it describes (`5963277`, undoing an earlier duplication) — a raw embedding-provider error can carry a URL, hostname, or upstream error body, and both `/api/stats`-shaped routes and `/api/context` report a fixed `"embedding_failed"` string through that one shared helper instead (`063d621`). The `degraded` boolean itself is unchanged and safe to expose.
- **The SessionStart hook (`cairn hook session-start`, `src/cli/hook.ts`) always exits 0 and writes only the envelope to stdout.** For that hook, stdout *is* model context — a stray diagnostic line becomes something the model reads and may act on. No daemon, a refused connection, a 401, a 500, malformed JSON, or an unexpected throw all end the same way: exit 0, empty stdout, diagnostics (if any) to stderr. It also enforces its own ~2s deadline shared across draining stdin, the daemon check, and the fetch, rather than trusting whatever timeout the calling client happens to use (`f58cb2a`). **This hook injects memory text into a session's single highest-trust position, and provenance is the gate on that, not a content filter.** Every memory carries `origin`/`approved` (`27d5b03`); this hook injects only user-originated or approved memories, so an imported or unreviewed memory can carry imperative text without it reaching a session automatically. The `get_context` MCP tool is a different trust boundary and is not gated the same way — see the next bullet.
- **`get_context` labels provenance instead of gating on it, and rows predating the migration are `unknown` until approved.** A model calling the tool deliberately can weigh a labelled imported memory itself, and excluding it there would silently break the portability promise for anyone who imported Claude/ChatGPT memories; only the automatic `SessionStart` path (above) excludes. `importMemory` re-derives `origin`/`approved` rather than trusting an archive's own claim — a crafted archive could otherwise self-certify as `user`-originated (`27d5b03`). A gate is only real if there is a verified way through it: the first version of this shipped with nothing calling `setMemoryApproved` (no route, no UI, no tool), so an upgraded store's SessionStart block went silent with no way to approve anything; there is now a per-row and bulk approve route and dashboard control, watched end to end on the live store (0 injected → 16).
- **`export_memories` writes with `wx` and refuses the daemon's own files by name, and containment is checked by realpath, not string comparison.** A lexical containment check never sees a symlinked parent directory, and string-identity file-name checks miss a trailing space, a trailing dot, or an alternate-data-stream suffix — all of which can alias `cairn.db` on some filesystem (`e6fa952`, `3e272af`).
- **Import runs in one transaction, episodes and memories together.** A checksum-valid archive containing one row the store rejects used to leave the store permanently half-imported with no record of where it stopped; one transaction now covers the whole loop (`0085bd2`).
- **An archive entry is capped at an absolute 64 MiB, not a derived one**, checked before any decoding — a derived cap bounded nothing, and a 410 KB archive alone drove a V8 heap fatal before this was fixed (`e6fa952`, `1963819`).
- **The ZIP's external attributes must carry a Unix file mode whenever "version made by" claims Unix provenance**, or every extracted file comes out at mode 000 (`4dde341`).
- **`verify-package` must run through `npm run` (or otherwise inherit `npm_execpath`) so it can resolve `npm` portably**, because `execFile('npm', ...)` fails with `ENOENT` on Windows (`c47f9ca`).
- **Every MCP tool handler and the resource mirror are wrapped once at registration by `withBoundedErrors`.** An unbounded id, cursor, or archive-derived string echoed into an error message is a prompt-injection channel into the model's context, not just an ugly error — measured at 500,000+ characters before the wrap, and the resource mirror was still missing it after the first pass that wrapped only the eight tools (`3e272af`, `6d08e56`).
- **Two things must not be duplicated by hand across file boundaries: input limits and the error scrubber.** Both drifted once already, purely because the security work was split across restricted-file-list agents who could not touch both sides at once; the numbers now live once in `src/storage/limits.ts` (imports nothing, to avoid a cycle) and the scrubber lives once beside the type it describes (`5963277`). If a fix needs the same constant or the same masking logic in two files, put it in one shared module instead of writing "keep in sync by hand" in a comment — that comment is a bug already filed, just not yet triggered.

## 5. What this project has learned the hard way

- **Green locally is not green.** Portability-milestone commits were pushed red on CI while every local run passed: an `unzip -O` flag only this machine's Info-ZIP build accepts, a file-permission check invisible to a process running as root, and a genuine product defect (files extracting at mode 000). None of those three show up in a run on this machine — reading the actual CI run, not trusting a local pass, is what found them. This is doubly true right now: CI itself is down (§1b), which does not mean the risk went away, only that nothing is watching for it.
- **A review finding is not a fact until it is reproduced.** Read the implementation before writing the finding down, not after; two early "findings" in this project turned out not to reproduce against the actual code.
- **Do not commit while an agent is still writing.** It has pushed non-compiling code to `main` before. The mechanical fix — snapshot `git diff HEAD | md5sum` before and after a test run, refuse to commit if it moved — is what actually catches it; a reminder to "be careful" does not.
- **Tests encoding the host OS.** A `C:\fake\home` literal is a relative path on POSIX; a `renameSync` onto a read-only file succeeds on POSIX but fails on Windows; a Windows-shaped config marker landed where the POSIX detector never looks. Ask the code under test for the real path/behaviour instead of hardcoding a platform's own; skip elsewhere with `t.skip("reason")` where a property is genuinely only measurable on one OS.
- **A security predicate duplicated in two places drifted, and so did input limits and an error scrubber.** The daemon-liveness/pid check, then later the input-size caps and the degraded-reason scrubber, all needed to live in exactly one place after drifting once each (`bd8f75b`, `5963277`) — see §4's last bullet for the rule this generalises to.
- **A test-runner flag silently dropped tests.** `--test-force-exit` masked a real hang, but on a slower CI runner it exited the process while a file still had queued subtests — tests vanished with no failure and no "cancelled" count. A green build that quietly ran less than it claimed is worse than a red one.
- **Killing a process by a recycled pid**, and **a "finding" that carried the secret it reported**, and **concurrent agents in one working tree corrupting each other** (`npm run clean` deleting another agent's in-flight build output, `git stash` reverting another agent's uncommitted files, a broad `git add -A` sweeping a half-finished file into an unrelated commit) — all still stand as recorded in earlier revisions of this document, and none of the root causes have reappeared since the fixes landed.
- **The security fixes themselves needed a rework pass**, and the rework's own root cause (§1a) generalises past this project: when N tests all fail off the back of one change, treat that as one question about the change, not N separate justifications to write down and move past. And **isolation between parallel agents must be real, not a file-list convention** — fourteen agents worked one shared tree this session, partitioned only by which files each was told to touch, and three lost uncommitted work to another agent's `git checkout`/`stash`/`reset`, because git reverts by repository and has no concept of a file-list agreement. The pattern that held up: `git worktree add <tmp> HEAD`, copy only your own files in, verify there, then apply back — a real filesystem boundary, not a promise.
- **A regression test is not proof until it has been watched to fail.** Every test added across the security and rework commits was reverted against the unfixed code, run, confirmed red, and restored — this caught more than one false positive, including a marker string in a test that was itself secret-shaped and got redacted by the very detector under test, which made the test pass for the wrong reason until someone actually watched it fail first.

## 6. How work is done here

Per `CLAUDE.md`: the orchestrator (Opus) reads, plans, specs, and reviews;
it does not write code. Every file change goes through a builder agent
(Sonnet, `Edit`/`Write`), then a read-only reviewer verifies it. The `duo`
skill runs that full loop; use it for anything that changes files rather
than improvising the handoff.

Six working rules this project now holds itself to, each learned from
an incident recorded in §1a/§5/§1c rather than adopted in the abstract:

1. **A regression test must be shown to fail against the unfixed code before it is trusted** — revert, run, watch it fail, restore. A test that has never failed has not proven anything yet, and this project has had a false-positive test slip through review on exactly this gap.
2. **Many tests failing off one change is one signal, not many.** Nine tests each independently rationalized with `minRelevance: 0` was the same defect reported nine times; the question to ask first is what the failures say in common, not why each one is individually fine.
3. **Isolation between parallel workers has to be real, not agreed.** A shared working tree partitioned by file-list convention is not isolation — git operates on the whole repository and does not know the convention exists. Use `git worktree add <tmp> HEAD`, copy in only the files you own, and verify there.
4. **Only pixels can judge a visual defect.** A provenance column rendered correctly in the DOM, typechecked, and passed 971 tests while being painted underneath a `position: sticky` column and invisible to the user — it survived two rounds of code review before anyone actually looked at a screen. Corollary, now in the code as a comment: nothing that must stay readable belongs immediately left of a sticky column.
5. **Every prohibition needs a verified way out.** Provenance gating was built correctly and shipped with nothing able to call `setMemoryApproved` — no route, no UI, no tool. On the live store the hook went silent with 18 memories and no way to approve any of them. Verify that a user can still act, not merely that the guard fires.
6. **`git stash` is repository-wide.** A worktree (rule 3) isolates file edits but NOT the stash; a stash taken inside a throwaway worktree appears in the main repository's stash list and can be popped over live work there.

Older verification discipline that still holds:
- **A claim is not reported until it has been reproduced**, ideally on the actual failing platform — "Local measurement is not evidence here: this Windows machine reports 0/60 both before and after. CI on macOS and ubuntu is the decisive check" (`25bfb73`).
- **Green output is not evidence on its own.** The `--test-force-exit` incident (§5) is the canonical example: the suite reported success while quietly running fewer tests than it claimed.

## 7. Open decisions that belong to the human

- **The package name is settled, not open.** The npm package is `cairn-mem` (`114cd47`) — `cairn` is an unrelated React Native styling library, `cairn-memory` is an active direct competitor on Elastic-2.0, `cairn-mcp` is another project. The product name stays Cairn, the bin stays `cairn`, the MCP server id clients see stays `cairn`, and `~/.cairn`/`CAIRN_HOME`/`CAIRN_PORT`/the dashboard client id are all unchanged. `cairn setup` now writes `npx -y cairn-mem@latest` into every client config it generates.
- **Publishing itself is the one thing left, and it is blocked on the owner's npm account, not a decision.** `npm publish --dry-run` succeeds end to end (§1b); the actual `npm publish` needs the owner's credentials, which this session does not have.
- **The demo/hero GIF.** BUILD_BRIEF §15 wants a hero GIF (Claude tells it something, Cursor recalls it) and a launch demo GIF — both need a human at a screen with a working dashboard. The dashboard exists and is screenshotted (`assets/`), so this is unblocked except for the human and the screen.

## 8. What comes next

Split by who can move it, because most of what remains is not something
the next session can pick up and finish alone.

**Blocked on the project owner:** everything that blocks the actual publish
— a payment method for CI, npm credentials, and disk space — plus the
order to do it in and how to verify each step, is now
[docs/RELEASING.md](RELEASING.md); read that instead of reconstructing the
steps here.
- **GitHub Actions billing.** Every CI run has failed in ~10s since 19:05 today with an account-payments message (§1b); nothing since `114cd47` is verified on Windows or macOS until this is fixed.
- **`npm publish`.** The dry run passes; the real publish needs the owner's npm credentials.
- **A real Claude or ChatGPT export.** `c2687d1`'s importer fixtures are built from documented and community-reported shapes, never a real Claude memory paste or a real ChatGPT `conversations.json` — the parsers are tested against constructed input, not reality, and only the owner can produce a real export to test against.
- **Disk space.** This machine is at 100% (97G/99G used, 715M free), 47 GB of it in directories unrelated to this project — worth knowing before a build or `npm pack` fails for a reason that looks like a code problem and isn't.

**Open engineering work, pick-up-able by the next session:**
- **No automated browser test exists.** The dashboard has been rendered and reviewed by a human once (§2); the mount closures beyond the pure helpers they call remain untested by anything automated.
- ~~The SessionStart hook has no defence against a memory's own content.~~ Closed by `27d5b03`: memories now carry `origin`/`approved`, and the hook injects only user-originated or approved rows (§4). What's left open is the limit already stated there and in SECURITY.md — nothing filters imperative content inside a memory the user *has* approved, or inside anything `get_context` returns labelled. That is a content-filtering problem, deliberately not attempted here because a filter is easy to evade; if it's ever tackled, it is additive to provenance, not a replacement for it.

`package.json` has no `files`-shaped concern left open (`edb359c`,
`c47f9ca`, `0085bd2`, `d4ccdec` closed that loop and `verify-package` now
guards it in CI — when CI is running), and THIRD_PARTY_LICENSES.md is
current as of the last dependency added.
