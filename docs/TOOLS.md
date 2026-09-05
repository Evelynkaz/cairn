# MCP tool reference

Cairn exposes exactly 8 MCP tools (BUILD_BRIEF §6's `≤ ~7` ceiling, with
`export_memories`/`import_memories` counted as one conceptual slot). Tool
sprawl past a handful measurably degrades client accuracy, so this list is
not going to grow casually. Source of truth: `src/mcp/tools.ts`.

Most tools accept forgiving parameter aliases (e.g. `q`/`text` for
`query`) so a model that names a parameter slightly wrong still succeeds
instead of failing the call — `remember`, `recall`, `get_context`,
`update_memory`, and `forget` do; `list_memories` only aliases its
camelCase boolean parameters (`includeDeleted`/`includeSuperseded`), and
`export_memories`/`import_memories` take none. Numeric parameters are
never rejected for being out of range or the wrong type (a numeric string
is fine) — they are clamped into range instead.

**`remember` never calls an LLM or the network.** It stores the memory
synchronously and returns immediately; any embedding happens later,
out-of-band, by a background indexer. This holds for every write path in
Cairn, not just `remember` — see BUILD_BRIEF §2.

## `remember`

Store a new memory. Call this whenever the user states a durable
preference, decision, personal fact, or correction — anything that should
still be true and recoverable in a future conversation, in this app or a
different one. Example: the user says "I prefer TypeScript over JavaScript
for new projects" — call `remember(content: "User prefers TypeScript over
JavaScript for new projects.")` right away, do not wait to be asked. Never
calls an LLM or the network: this is a local, instant write.

| parameter | aliases | notes |
|---|---|---|
| `content` (required) | `text` | the memory text to store |
| `tags` | — | array of free-form labels |
| `scope` | — | namespace, defaults to `"default"` |
| `source` | — | free-text provenance note, not used for retrieval |
| `importance` | — | 0–1, defaults to 0.5; out-of-range/non-numeric values are clamped |

Output: `{ id, deduped, episodeId }`.

## `recall`

Search stored memories by meaning and keywords (hybrid FTS5 + vector,
RRF-fused). Call this BEFORE answering anything that may depend on prior
context — the user's preferences, past decisions, project facts, or
anything they told a different MCP client earlier. Example: before
answering "what database did we pick?", call `recall(query: "database
choice")` first instead of guessing or asking again.

| parameter | aliases | notes |
|---|---|---|
| `query` (required) | `q`, `text` | search text |
| `limit` | — | max results, defaults to 10, capped at 50 |
| `scope` | — | restrict to one namespace |
| `tags` | — | only memories carrying ALL of these tags |

Output: `{ hits: [...], degraded, degradedReason }` — up to `limit` hits
(bounded at 50).

## `get_context`

Return one budgeted block (~800 tokens by default) of the most relevant
memories, ready to paste into context. Call this BEFORE answering anything
that may depend on prior context, especially at the start of a session —
instead of dumping the whole memory store, which pollutes context. Example:
at the start of a conversation, call `get_context()` with no query for a
budgeted index of what matters right now, or `get_context(query:
"deployment process")` for a specific question.

| parameter | aliases | notes |
|---|---|---|
| `query` | `q`, `text` | omit for a general "what matters right now" index |
| `token_budget` | — | approximate max size in tokens, defaults to ~800; never raise this to "get everything" |
| `scope` | — | restrict to one namespace |
| `tags` | — | only memories carrying ALL of these tags |

Output: `{ text, memories: [...], tokensEstimated, truncated, degraded,
degradedReason }`. This is the same budgeted-block code path the
`SessionStart` recall hook uses — see
[docs/RECALL_HOOK.md](RECALL_HOOK.md) for how that hook makes the first
recall of a session automatic instead of depending on the model to call
this tool.

## `list_memories`

Browse stored memories with pagination — for auditing, curating, or finding
a memory to update or forget when a fuzzy recall search is not precise
enough. Example: `list_memories(scope: "work", limit: 20)` to see the most
recent memories in a scope, then page further with the returned
`nextCursor`. Not for answering a question — call `recall` or `get_context`
for that instead.

| parameter | aliases | notes |
|---|---|---|
| `scope` | — | restrict to one namespace |
| `tags` | — | only memories carrying ALL of these tags |
| `cursor` | — | opaque pagination cursor from a previous call's `nextCursor` |
| `limit` | — | page size, defaults to 50, capped at 200 |
| `include_deleted` | `includeDeleted` | include soft-deleted (forgotten) memories; defaults to false |
| `include_superseded` | `includeSuperseded` | include memories superseded by a newer fact (§5's temporal supersede-not-delete); defaults to false |

Output: `{ items: [...], nextCursor }` — up to `limit` items (bounded at
200).

## `update_memory`

Edit an existing memory's content, tags, or importance. Call this when the
user corrects or refines something already stored, instead of creating a
duplicate with `remember`. Example: the user says "actually, make that more
important" — call `update_memory(id: "...", importance: 0.9)`.

| parameter | aliases | notes |
|---|---|---|
| `id` (required) | — | memory id from a previous remember/recall/list_memories call |
| `content` | `text` | new text, replacing the old |
| `tags` | — | replaces the memory's tags entirely |
| `importance` | — | 0–1, replaces the stored value; omit to leave unchanged (clamped if out of range) |

Output: the updated memory object.

## `forget`

Delete a memory. Call this when the user explicitly asks to forget,
delete, or remove something they told you.

- With an `id`: deletes that one memory immediately (soft-delete,
  reversible).
- With a `query` and no `confirm: true`: this ONLY PREVIEWS what would be
  deleted and deletes NOTHING.
- With `query` and `confirm: true`: re-runs the search and deletes its
  current results.
- SAFEST form: pass back the `ids` a preview returned, with `confirm:
  true` — `forget(ids: [...], confirm: true)` — so the delete removes
  exactly what the user saw, even if another client wrote or changed
  memories in between.

Example: the user says "forget what I told you about my old job" — call
`forget(query: "old job")` to see the preview, confirm with the user, then
call `forget(query: "old job", confirm: true)`.

| parameter | aliases | notes |
|---|---|---|
| `id` | — | exact memory id to delete; provide this OR `query`, not both |
| `query` | `q`, `text` | text describing what to forget; without `confirm: true`, only previews |
| `scope` | — | restrict the `query` search to one namespace |
| `ids` | — | exact ids to delete, from a previous preview; requires `confirm: true` |
| `confirm` | — | must be `true` to actually delete |

Output (by id): `{ deleted, id }`. Output (confirmed `ids`): `{ deleted,
count, ids }`. Output (preview, no confirm): `{ deleted: false, count: 0,
ids, wouldDelete, message }`. Output (confirmed query): `{ deleted, count,
ids }`. A query-shaped forget never deletes without an explicit `confirm`.

## `export_memories`

Back up or move the user's whole memory store to a file on disk. Call this
when the user asks to back up, export, or move their memory to another
machine. Example: the user says "back up my memories before I reset my
laptop" — call `export_memories(path: "backup.zip")` (or omit `path` for a
timestamped default under the Cairn home).

| parameter | aliases | notes |
|---|---|---|
| `path` | — | where to write the archive; defaults to a timestamped file under the Cairn home; must resolve inside the Cairn home directory |
| `scope` | — | export only one namespace instead of every scope |

Output: `{ path, bytes, memories, episodes }` — never the memory contents
themselves, so a large store never floods this response. Refuses to
overwrite an existing file.

## `import_memories`

Merge memories from a previously exported archive file into the store.
This MERGES — it never replaces or overwrites anything: a memory whose id
or content is already present is skipped, so importing the same archive
twice is safe and imports nothing the second time. Call this when the user
asks to restore a backup or bring memories over from another machine.
Example: the user says "load the memories I exported from my old laptop" —
call `import_memories(path: "backup.zip")`. Never present this as a
destructive restore; it is additive only.

| parameter | aliases | notes |
|---|---|---|
| `path` (required) | — | path to a Cairn export archive (`.zip`) previously written by `export_memories`; unconfined (unlike `export_memories`'s `path`), capped at 200 MB |
| `scope` | — | attributed scope for this import call's own audit entry |

Output: `{ imported, skipped }`. Any unreadable/nonexistent/oversized path,
or a file that isn't a valid Cairn archive, produces the same fixed
message (`import_memories: no readable archive at that path`) rather than
letting the tool be used to probe the filesystem's contents.
