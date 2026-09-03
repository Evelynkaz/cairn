# Contributing to Cairn

Cairn is pre-alpha. Before writing any code, **read
[docs/BUILD_BRIEF.md](docs/BUILD_BRIEF.md)** — it is the single source of
truth for what to build, why, and in what order.

## Dev setup

The project scaffold does not yet have a working build. Once implemented:

```
npm install
npm run build
npm test
```

(Placeholders for now — see `package.json`.)

## Guidelines

- **English only** — code, comments, commit messages, docs.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`, …). Explain
  *why* in the body when the change isn't self-evident.
- Keep the tool surface small and follow the non-negotiable principles in
  §2 of the build brief (local-first, zero-config, zero-inference writes,
  privacy by default).
- No third-party code is vendored without recording its license in
  `THIRD_PARTY_LICENSES.md`.
- No CLA required — contributions are accepted under the project's MIT
  license.

## Never run `cairn setup` for real against your own machine

During verification of a past milestone, an agent ran `cairn setup` for
real. It wrote a `cairn` entry into the developer's actual `~/.claude.json`,
pointing at an unpublished package, so the editor would have failed to
launch it every session from then on. The backup mechanism worked and the
entry was removed by hand, but the run should never have happened.

Any command that writes outside the repository -- `cairn setup` above all --
must be verified with `--dry-run`, or with `HOME`/`USERPROFILE` pointed at a
temp directory, never against the machine you are working on. `CAIRN_HOME`
does **not** isolate this: client config paths (`~/.claude.json`,
`~/.cursor/mcp.json`, the Claude Desktop config path) are deliberately
outside `CAIRN_HOME`, by design.

## Tests must not encode the host OS's filesystem semantics

A test that passes on one platform and fails on another because it baked in
that platform's filesystem behaviour is a bug in the test, not a green light
to special-case it by OS. Two real examples that broke CI: a `C:\fake\home`
literal used as a path, which is actually a relative path on POSIX; and a
`renameSync` onto a read-only file, which succeeds on POSIX (rename only
needs write permission on the directory) but fails on Windows. Where a
property can genuinely only be measured precisely on one platform (e.g. exact
open file descriptor counts, which are only readable via `/proc/self/fd` on
Linux), the test skips elsewhere with `t.skip("reason")` rather than
asserting a proxy that can fail at random.

## Pull requests

Keep changes focused and runnable at every step. Add or update tests for
anything you touch. CI must be green on all three platforms.

## `npm test` must exit on its own -- no `--test-force-exit`

The suite used to run with `--test-force-exit` to paper over a hang. It was
removed: on a slower CI runner, force-exiting the process while a file still
had queued subtests silently dropped five tests from `src/storage/store.test.ts`
out of the plan -- no failure, no "cancelled" count, they just never appeared.
A green build that quietly ran less than it claims is worse than a red one.

The rule now is simple: anything a test (or the code under test) opens must
be closed by the time the file's tests finish, so the process's event loop
empties on its own. `src/shim/shim.test.ts` and `src/daemon/server.test.ts`
close the global `fetch` keep-alive pool (undici's global dispatcher) in an
`after()` hook, since `StreamableHTTPClientTransport` uses it and there is no
public API to close it per-test. `src/daemon/server.ts`'s own `close()`
awaits both `httpServer.closeAllConnections()` and `httpServer.close()`
(the callback form, which only resolves once every connection is gone) --
that is exercised by its own test. If a future change makes a *process* hang
rather than the test runner's own exit, treat that as a real bug and find the
open handle (`process.getActiveResourcesInfo()` is the fastest way in), not
something to paper over with this flag again.
