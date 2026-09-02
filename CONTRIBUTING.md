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
