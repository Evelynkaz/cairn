# Installing Cairn

## Status: published on npm as `cairn-mem`

Cairn is on the npm registry as the package **`cairn-mem`** (the product is
Cairn; the command is `cairn`; the package name differs only because
`cairn` was taken). The zero-config way to run it:

```bash
npx cairn-mem            # run it (starts the daemon on first client use)
npx cairn-mem setup      # wire up Claude Desktop / Claude Code / Cursor
npx cairn-mem ui         # open the dashboard
```

Everywhere below, `cairn <command>` means `npx cairn-mem <command>` (or the
`cairn` binary if you installed it globally with `npm install -g cairn-mem`).

To run from a clone instead — for contributing, or to build from source:

```bash
git clone https://github.com/Evelynkaz/cairn.git
cd cairn
npm install
npm run build
node dist/cli/index.js        # the same CLI, run directly
```

## CRITICAL SAFETY RULE: never run `cairn setup` without `--dry-run` first

`cairn setup` writes **outside this repository**, into the real MCP client
config files on the machine it runs on (Claude Desktop's
`claude_desktop_config.json`, Claude Code's `~/.claude.json`, Cursor's
`~/.cursor/mcp.json`). It will create, merge into, or overwrite those files.

Before ever running `cairn setup` for real, preview what it would do:

```bash
node dist/cli/index.js setup --dry-run   # reports created/updated/replaced per client, writes nothing
node dist/cli/index.js setup --print     # prints the exact JSON entry cairn would write for each client
```

If you are verifying Cairn's behavior (not actually installing it for
yourself), use `--dry-run` or `--print` only. Never run `cairn setup` for
real as part of a verification pass — it mutates a real config file on the
machine.

`--client=<id>` restricts setup to one or more clients by id (`claude-desktop`,
`claude-code`, `cursor`); pass it more than once to select several. Whenever
a client's config file already exists and is writable, setup backs it up
next to itself (`<configPath>.cairn-backup-<timestamp>`) before writing —
not only when it already contains a different `cairn` entry.

## Per-client install

### Claude Desktop

`cairn setup` writes to:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

It only writes if that path (or its parent directory) already exists — i.e.
if Claude Desktop is installed. The entry it writes (see
`examples/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cairn": {
      "command": "npx",
      "args": ["-y", "cairn-mem@latest"]
    }
  }
}
```

To wire it up by hand instead, merge that `cairn` entry into your existing
`mcpServers` object in the file above and restart Claude Desktop.

### Claude Code

`cairn setup` writes to `~/.claude.json`, using the same stdio entry shape
as above. Claude Code writes to this file continuously while it's running,
so `cairn setup` warns and prefers a safer route:

```bash
claude mcp add cairn -- npx -y cairn-mem@latest
```

Close Claude Code before letting `cairn setup` touch `~/.claude.json`
directly, or use the `claude mcp add` command instead — either is
equivalent to hand-editing:

```json
{
  "mcpServers": {
    "cairn": {
      "command": "npx",
      "args": ["-y", "cairn-mem@latest"]
    }
  }
}
```

Claude Code also supports the SessionStart recall hook, which makes the
first `recall` of a session automatic instead of relying on the model to
call it. See [docs/RECALL_HOOK.md](RECALL_HOOK.md) for the exact settings
snippet — `cairn setup` does not write it for you.

### Cursor

`cairn setup` writes to `~/.cursor/mcp.json`, again only if that path (or
its parent directory) exists. Same entry shape (see
`examples/cursor_mcp.json`):

```json
{
  "mcpServers": {
    "cairn": {
      "command": "npx",
      "args": ["-y", "cairn-mem@latest"]
    }
  }
}
```

To wire it up by hand, merge the `cairn` entry into `~/.cursor/mcp.json`'s
`mcpServers` object and restart Cursor.

Cursor's session-start hook support, if it exists at all, is not covered —
see the "What this does not do" section of
[docs/RECALL_HOOK.md](RECALL_HOOK.md).

## Verify it worked

```bash
node dist/cli/index.js status
```

This reports whether the daemon is running (pid, port, URL), the memory and
vector counts, the embedding provider's availability, and the database
path. A fresh install with no daemon running yet will report `daemon: not
running` — that's expected; the stdio shim auto-starts the daemon the first
time a client connects, or you can start it yourself with
`node dist/cli/index.js start`.

**Cross-client check** (the point of Cairn): after wiring up two clients
(e.g. Claude Desktop and Cursor),

1. In one client, ask it to remember something: "remember that I prefer
   TypeScript over JavaScript for new projects."
2. In the other client, in a new conversation, ask it something that
   depends on that fact: "what language do I prefer for new projects?"

Both clients talk to the same daemon and the same SQLite file, so the
second client should recall what the first one stored, with no shared
account or cloud service involved.

## Troubleshooting

**Daemon not starting.** Run `node dist/cli/index.js start` directly and
read its error. Common causes: the Cairn home directory
(`~/.cairn` by default, see below) isn't writable, or another process
already holds the port (see next point). `node dist/cli/index.js status`
also reports a stale runtime file (a pid that's no longer running) —
`start` cleans that up automatically.

**Port already in use.** The daemon defaults to port `8787`. Override it
with the `CAIRN_PORT` environment variable, e.g. `CAIRN_PORT=8888 node
dist/cli/index.js start`. If a stale Cairn daemon is holding the port, stop
it first with `node dist/cli/index.js stop`.

**FTS-only mode (no embedding model).** By default, embeddings are off and
Cairn runs in keyword-only (FTS5) mode — this is the zero-config, no-model-
download starting state, not an error. `node dist/cli/index.js status` (or
`embeddings status`) reports the provider as `off` in this mode. To turn on
local semantic search: `node dist/cli/index.js embeddings enable`, which
records consent only — it does not download anything itself. The model
runtime (`@huggingface/transformers`) installs on first real use by the
daemon's background indexer; `embeddings status` explains what's still
missing in the meantime. `node dist/cli/index.js embeddings disable` turns
it back off.

**Where's the database?** One file: `~/.cairn/cairn.db` (WAL-mode SQLite),
alongside its `-wal`/`-shm` siblings and the daemon's runtime file, all
under `~/.cairn`. Override the whole Cairn home directory (not just the db)
with the `CAIRN_HOME` environment variable, e.g. `CAIRN_HOME=/path/to/dir
node dist/cli/index.js status`.
