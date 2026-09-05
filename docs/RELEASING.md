# Releasing Cairn

An ordered runbook for the first (and every subsequent) `npm publish` of
`cairn-mem`. Follow it top to bottom; don't skip a step because a nearby one
looks green. Every command below is either a `package.json` script or a
real CLI invocation used elsewhere in this repo (CI, CONTRIBUTING.md,
docs/HANDOFF.md) — none of it is invented.

This document assumes you have what the next session did not: a payment
method on the GitHub Actions account, npm publish credentials, and enough
disk to build with. See §6 before you start if disk is tight.

## 1. Preconditions

Run these in order. Each one gates the next — don't skip ahead because you
"already know" the answer.

**1.1 — Working tree clean.**

```
git status --porcelain
```
Expect: no output. Anything printed means uncommitted changes; commit or
discard them before continuing — a release must build from a committed
tree, not from whatever happens to be on disk.

**1.2 — Typecheck.**

```
npm run typecheck
```
Expect: no output (three `tsc -p ... --noEmit` projects, all clean — root,
dashboard UI, UI tests). Any printed error is a compile error; fix it, do
not release around it.

**1.3 — Full test suite, and it must exit on its own.**

```
npm test
```
This runs `clean` → `build` → `node --test dist/**/*.test.js`. It must end
the process by itself — if it hangs, that's a real bug (see
CONTRIBUTING.md's "`npm test` must exit on its own" section), not something
to work around with a force-exit flag.

Expect a summary line block like:
```
# tests 977
# suites 0
# pass 971
# fail 0
# cancelled 0
# skipped 6
```
**The exact numbers above (977/971/0/6) are a snapshot from 2026-09-05, not
a target to match.** They will drift as the tree changes. What actually
gates a release is: `# fail 0` and `# cancelled 0`, always; then read *why*
the skipped count is whatever it is (CONTRIBUTING.md documents one
legitimate skip — an `ensureHome` test that skips under `process.getuid?.()
=== 0`, i.e. running as root) before trusting a changed number is fine.
Never publish on `# fail` > 0, and never publish on a suite that force-exits.

**1.4 — Verify the packed contents.**

```
npm run verify-package
```
Expect: `verify-package: package contents OK` after checking the bin entry,
all twelve dashboard asset files, and that no test artifact or `src/` tree
leaked into the tarball. It also prints a file count (`npm pack would ship
N file(s)`) — **164 as of 2026-09-05, up from an earlier 162; treat this as
a snapshot of the current tree, not a fixed number to assert against.** If
the count moves, that's expected as files are added/removed — what matters
is that this line says `OK`, not that the count matches a memorized value.

**1.5 — Dry-run publish.**

```
npm publish --dry-run
```
Expect it to end with `+ cairn-mem@<version>` and no error. This exercises
the actual tarball npm would upload (via `prepublishOnly`, see §3) without
sending anything. `npm warn ... requires you to be logged in ... (dry-run)`
is expected and harmless at this stage — you don't need to be logged in yet
to dry-run.

## 2. The CI gate, and why it is not optional

CI has been failing since the GitHub Actions account's billing lapsed —
every job dies in about two seconds with an account-payments message.
Confirm the current state before assuming it's fixed:

```
gh run list --limit 5
```
If every row still says `failure` in ~10s, billing is still broken; do not
proceed to §3 until at least one full run — `build` and `smoke`, all three
OSes (ubuntu/macos/windows) — is green. **Nothing landed since `114cd47`
has been verified on Windows or macOS.**

This is not a formality. A hand audit, standing in for CI because CI could
not run, found that the same day's own security fix had broken
`export_memories` outright on macOS: the symlink containment guard compared
a realpath'd directory against a home directory that was never realpath'd,
and macOS's `/var` is itself a symlink — so every export on macOS was
refused. Nothing about that bug was visible from a green Linux run; only a
real macOS run (or, that day, a by-hand audit) caught it. A green run on
this machine alone proves the package isn't broken outright — it does not
prove it works on the two platforms nobody has actually run it on since.

Do not publish on a Linux-only green run. When CI comes back, the ranked
list of what to check first (found by the hand audit, never verified on
real hardware) is in `docs/HANDOFF.md` §1c — read it there rather than
re-deriving it here.

## 3. Publishing

**3.1 — Log in.**
```
npm whoami
```
If this errors instead of printing a username, log in first:
```
npm login
```

**3.2 — Re-check the name is still free.** It was available hours/days ago
(`npm view cairn-mem` returned 404 on 2026-09-05); names are claimed
continuously, so re-check immediately before publishing, not from memory:
```
npm view cairn-mem
```
Expect: `npm error 404 Not Found` (the name is still unclaimed). If this
instead prints package info, someone else has published `cairn-mem` first
— stop, this is a decision for the project owner (rename, or contact npm
support), not something to work around.

**3.3 — Publish.**
```
npm publish
```
`prepublishOnly` (in `package.json`) runs `clean` → `build` →
`verify-package` automatically before the tarball is uploaded, so this
cannot ship a stale `dist/` — if `verify-package` fails, the publish aborts
before anything is sent. This is the first publish of this package: it
both ships v0.1.0 *and* claims the `cairn-mem` name on the registry. There
is no dry-run equivalent of "undo" once this succeeds — see §5 if it goes
out broken.

## 4. After publishing

Don't assume the registry has what you think you uploaded — verify it.

**4.1 — Install the published artifact into a scratch directory outside the repo**, the same shape as CI's `smoke` job:
```
mkdir -p /tmp/cairn-release-check && cd /tmp/cairn-release-check
npm init -y
npm install cairn-mem
```

**4.2 — Run the CLI by its resolved path** (not via a `bin` shim on PATH — see the comment in `.github/workflows/ci.yml`'s `smoke` job for why):
```
node node_modules/cairn-mem/dist/cli/index.js --version
node node_modules/cairn-mem/dist/cli/index.js status
```
Expect `--version` to print the version you just published.

**4.3 — Start the daemon, hit `/health`, stop it:**
```
CAIRN_HOME=/tmp/cairn-release-check/home node node_modules/cairn-mem/dist/cli/index.js start
node node_modules/cairn-mem/dist/cli/index.js status --json   # read the daemon.url from this
curl -s http://127.0.0.1:<port-from-status>/health
node node_modules/cairn-mem/dist/cli/index.js stop
```
Expect a 200 from `/health`, and `stop` to report the daemon stopped.

**4.4 — Confirm the zero-config front door works**, since that's §2's
actual promise:
```
cd /tmp && npx cairn-mem@latest --version
```

**4.5 — Update the README and CHANGELOG.** Both currently say "not yet
published" / carry an `[Unreleased]`/`[0.1.0] - unreleased` heading with no
date (see `README.md`'s "Status: pre-release" banner and Install section,
and `CHANGELOG.md`'s top). Once the above all pass:
- Fill in the CHANGELOG's release date and remove the "unreleased" framing.
- Update the README's install instructions and status banner to reflect
  that `npx cairn-mem` is live.

**4.6 — Tag the release:**
```
git tag v<version>
git push origin v<version>
```
(Only after committing the README/CHANGELOG updates from 4.5.)

## 5. Rollback

If the published package turns out to be broken, **do not `npm unpublish`.**
npm's unpublish policy window is narrow (24 hours for a brand-new package,
and it can break anyone who has already installed it — for a package that
also just claimed a name, unpublishing can even free the name for
squatting). Instead:

```
npm deprecate cairn-mem@<broken-version> "explain the problem and point at the fix here"
```
then fix the issue and publish a patch version through the normal §1–§3
flow. This is the step people get wrong under pressure — resist the urge
to unpublish "to make it go away."

## 6. The environment gotcha

This machine has been at or near 100% disk (602 MB free as of 2026-09-05).
A build or `npm pack` failing with an `ENOSPC`-shaped error is a disk
problem, not a code problem — check disk first before debugging the build:
```
df -h /
```
Roughly 3 GB is recoverable from regenerable caches if you need headroom:
```
rm -rf ~/.cargo/registry/cache ~/go/pkg/mod/cache ~/.cache && npm cache clean --force
```
These are all caches that repopulate on next use; none of it is source or
build output.

## 7. What is still unverified at publish time

Say this plainly in the release notes so they stay honest:

- **The Claude/ChatGPT importers have never been run against a real vendor
  export.** They're tested against constructed fixtures only. Import now
  previews before writing, so a bad parse is visible before it touches the
  store and is reversible — but "reversible" is not "correct."
- **There is no automated browser test for the dashboard.** It has been
  reviewed by hand in a real browser once; nothing in CI checks it.
- **Windows and macOS depend entirely on CI being restored** (§2). Until a
  full three-OS run goes green, treat both as unverified regardless of how
  clean the Linux run looks.
