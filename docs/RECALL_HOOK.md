# The recall hook (`cairn hook session-start`)

## Why this exists

BUILD_BRIEF §8 makes a specific claim: telling a model, in a system prompt,
"call `recall` before answering anything that may depend on prior context" is
only about 60-70% reliable. Models sometimes just don't call the tool. A
memory server that depends on that alone will silently fail to inject
relevant memory some fraction of the time, with no visible error.

`cairn hook session-start` makes the *first* recall of a session
deterministic instead: wired into Claude Code's `SessionStart` hook, it runs
automatically, fetches a ranked, budgeted index from your local Cairn daemon,
and injects it as context -- no tool call, no model judgment call, required.

The injection is capped at **~800 tokens by default**. That budget is
enforced by the daemon itself, in `src/retrieval/context.ts` (the same code
path behind the `get_context` MCP tool and the dashboard's `/api/context`
route), not by this hook. §8/§14 name the failure this exists to avoid:
"context pollution" -- a documented case of a project dumping its entire
memory store into context on every turn and having to retreat back to a
small, budgeted index. This hook only ever asks for that small index; it has
no way to ask for more.

## The settings snippet

Paste this into `~/.claude/settings.json` (all projects) or a project's own
`.claude/settings.json` (that project only):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "cairn hook session-start"
          }
        ]
      }
    ]
  }
}
```

This is the nested shape (a matcher group containing a `hooks` array), which
matches Claude Code's documented shape for its other hook events. We found
one source describing a flatter `{"matcher": "...", "type": "command",
"command": "..."}` shape instead; we could not confirm which is correct for
`SessionStart` in every Claude Code version, so we are showing the one that
is consistent with the rest of the documented hook system. **If this does
not fire, check your installed Claude Code version's own hook
documentation** rather than assuming this snippet is wrong.

## The system-prompt snippet

Pair the hook (which handles the *start* of a session) with an instruction
that covers the rest of it -- BUILD_BRIEF §8's third leg. Paste this into
your system prompt or a project's `CLAUDE.md`:

```
Track the user's identity, preferences, goals, and decisions as they come
up in conversation. When the user states something durable (a fact about
themselves, a preference, a goal, a decision), call `remember` to store it.
Before answering anything that may depend on prior context, call `recall`
to check for relevant stored memory first.
```

## What this does not do

- **It does not install itself.** `cairn setup` wires MCP client configs
  (Claude Desktop, Claude Code, Cursor), but it deliberately does not write
  hooks into `settings.json` for you. Writing a possibly-wrong hook shape
  into a real config is exactly the class of mistake this project's
  CONTRIBUTING.md warns about (an agent once wrote a broken entry into a
  developer's real `~/.claude.json`). Paste the snippet above yourself.
- **It does not cover Cursor.** Two sources disagreed on whether Cursor even
  has a session-start-equivalent hook at all. Rather than ship a snippet we
  have not verified, we are saying plainly: Cursor's equivalent, if one
  exists, is not covered here.
