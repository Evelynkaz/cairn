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

## Pull requests

Keep changes focused and runnable at every step. Add or update tests for
anything you touch. CI must be green on all three platforms.

## Why `npm test` runs with `--test-force-exit`

The shim tests spin up real MCP clients over `StreamableHTTPClientTransport`,
whose `fetch`-based transport pools keep-alive sockets on the client side;
those sockets can outlive the individual test even after every assertion has
passed and every daemon/shim child process this repo spawned has been
explicitly closed or killed. Node's test runner otherwise waits for the event
loop to go empty before exiting, so it hangs on those pooled sockets. `--test
--test-force-exit` is Node's supported remedy for exactly this situation.
This flag is **not** a license to leak resources: anything Cairn itself opens
(daemon child processes, its HTTP server, file handles) must still be closed
by the code and by the tests, and the daemon's own connection teardown
(`httpServer.closeAllConnections()` in `src/daemon/server.ts`) is exercised
by its own test. If a future change makes a *process* hang rather than the
test runner's own exit, treat that as a real bug, not something to paper over
with this flag.
