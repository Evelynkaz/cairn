// The BUILD_BRIEF §6 tool surface: eight tools, a hard ceiling. §6 lists
// export_memories/import_memories as one line item joined by a slash --
// one conceptual slot -- and §2's ceiling is written "≤ ~7" with a tilde,
// whose stated rationale is that sprawl PAST ~50 tools measurably degrades
// client accuracy; competitors shipping 50-83 tools are the target, not an
// eighth here. A single tool with a `direction: "in" | "out"` flag was
// considered and rejected: a direction parameter on a tool that can
// overwrite a user's memory store is exactly the ambiguity that makes a
// model mis-fire, and §6 wants verb-first names. Do not add a ninth for
// convenience, and do not relitigate this split back into one tool.
//
// Tool descriptions are product copy, not code comments (§8): each one
// states WHEN to call it, with a concrete example, because instruction-only
// orchestration is only ~60-70% reliable on its own.

import { z } from "zod";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CallContext, Memory, SearchHit } from "../storage/index.js";
import type { McpDeps } from "./deps.js";
import { DASHBOARD_CLIENT } from "../config/identity.js";
import { resolveCairnHome, ensureHome, dbPath } from "../config/paths.js";
import { runtimeFilePath } from "../daemon/runtime-file.js";
import { exportArchive, importArchive, ArchiveFormatError } from "../portability/archive.js";
import { recordAudit } from "../storage/repositories/audit.js";

// The label used when a connected client did not identify itself (a bare
// stdio pipe, or a client that skips clientInfo). Kept distinct from `null`
// so the §9 connected-apps / access log view always has something readable
// to render, never a blank or a thrown error.
export const UNKNOWN_CLIENT = "unknown-client";

export function sourceClientName(server: McpServer): string {
  const name = server.server.getClientVersion()?.name;
  if (name === undefined || name.trim().length === 0) return UNKNOWN_CLIENT;
  // §9: `cairn-dashboard` is a reserved identity -- the dashboard's own
  // `clients` row is the one the user is guaranteed to be able to pause
  // (its PATCH handler refuses to disable it). If an MCP client were
  // allowed to claim that same name, it would share that row: its writes
  // would be attributed to "cairn-dashboard" and it would inherit the
  // un-pauseable guard, making an impersonator un-stoppable. Refuse the
  // claim rather than let any MCP client occupy the reserved id.
  return name === DASHBOARD_CLIENT ? UNKNOWN_CLIENT : name;
}

export function callContext(server: McpServer, scope?: string): CallContext {
  return { sourceClient: sourceClientName(server), scope };
}

// How mutation handlers reach the server's resource-subscription state
// (server.ts owns the subscribed-URI set; tools.ts only mutates through
// this, never `server.server.sendResourceUpdated` directly) -- §6 requires
// `notifications/resources/updated` to go ONLY to clients that actually
// subscribed to that URI.
export interface ResourceEvents {
  notifyUpdated(uri: string): Promise<void>;
  notifyListChanged(): void;
}

export const MEMORIES_LIST_URI = "cairn://memories";
const MEMORY_URI_PREFIX = "cairn://memory/";
export const MEMORY_URI_TEMPLATE = `${MEMORY_URI_PREFIX}{id}`;

export function memoryUri(id: string): string {
  return `${MEMORY_URI_PREFIX}${id}`;
}

export function memoryToJson(memory: Memory): Record<string, unknown> {
  return {
    id: memory.id,
    text: memory.text,
    scope: memory.scope,
    tags: memory.tags,
    importance: memory.importance,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    lastAccessed: memory.lastAccessed,
    accessCount: memory.accessCount,
    sourceClient: memory.sourceClient,
  };
}

function hitToJson(hit: SearchHit): Record<string, unknown> {
  return {
    id: hit.id,
    text: hit.text,
    score: hit.score,
    scope: hit.scope,
    tags: hit.tags,
    importance: hit.importance,
    createdAt: hit.createdAt,
  };
}

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// Mirrors src/dashboard/api.ts's toSafeDegradedReason: the retrieval layer's
// raw `degradedReason` (src/retrieval/search.ts's catch block) is whatever
// text an HTTP-backed embedding provider's failure carried, which can embed
// `${response.status} ${readBodyExcerpt(...)}` of the upstream response --
// a provider URL, a host name, or raw upstream error body. That text must
// never reach an MCP client verbatim (the same no-echo rule the dashboard's
// API already applies over this daemon); keep the detail on stderr only and
// return this fixed value instead. `degraded` (the boolean) is untouched.
type SafeDegradedReason = "embedding_failed" | null;
function toSafeDegradedReason(degraded: boolean, rawReason: string | null): SafeDegradedReason {
  if (degraded && rawReason) {
    // The detailed, potentially upstream-carrying text stays on stderr for
    // whoever operates this daemon -- it never reaches the MCP client.
    console.error(`degraded retrieval: ${rawReason}`);
  }
  return degraded ? "embedding_failed" : null;
}

// Picks the first non-blank value, in order -- how remember/recall/get_context/
// forget resolve their forgiving parameter aliases (BUILD_BRIEF §6: `q`/`text`
// for `query`, `text` for `content`) before validating anything, so a
// mis-named parameter never fails the call.
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) return value;
  }
  return undefined;
}

// Same forgiving-alias principle as firstNonEmpty, for the snake_case/
// camelCase boolean pair list_memories accepts (BUILD_BRIEF §6:
// `include_deleted`/`includeDeleted`, `include_superseded`/
// `includeSuperseded`). Absent on both spellings defaults to false.
function firstBoolean(...values: Array<boolean | undefined>): boolean {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return false;
}

// A number-or-numeric-string schema for every bounded numeric parameter
// below. Ordinary model mistakes -- an out-of-range or string-typed number
// -- must not fail the call (BUILD_BRIEF §6's forgiving-parameter
// principle applies to a mis-VALUED param the same as a mis-NAMED one): no
// `.min`/`.max` here, the real bound is documented in each `.describe()`
// text instead and enforced by clamping in the handler.
const numberOrNumericString = z.union([z.number(), z.string()]);

function coerceNumber(value: number | string | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

// Integer params with a real default (limit, page size): truncate, clamp
// into [min, max], fall back to `fallback` on NaN/absent.
function clampInt(value: number | string | undefined, min: number, max: number, fallback: number): number {
  const n = coerceNumber(value);
  if (n === undefined) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// A lower-bounded integer with no default of its own here: absent/NaN
// resolves to `undefined`, letting the layer below apply its own default
// (used for token_budget, whose ~800 default already lives in retrieval).
function clampIntMin(value: number | string | undefined, min: number): number | undefined {
  const n = coerceNumber(value);
  if (n === undefined) return undefined;
  return Math.max(min, Math.trunc(n));
}

// Importance (0..1) on a write that always stores a value: clamp, fall
// back to `fallback` on NaN/absent.
function clampUnit(value: number | string | undefined, fallback: number): number {
  const n = coerceNumber(value);
  if (n === undefined) return fallback;
  return Math.min(1, Math.max(0, n));
}

// Importance (0..1) on a PATCH: absent must stay absent -- it means "leave
// the stored value unchanged", not "reset to a default" -- so only clamp
// when a value was actually given.
function clampUnitOptional(value: number | string | undefined): number | undefined {
  const n = coerceNumber(value);
  return n === undefined ? undefined : Math.min(1, Math.max(0, n));
}

// Default export destination: under the user's Cairn home (§3's "one file
// on the user's machine" home), named with a timestamp so repeated exports
// never collide or silently overwrite an earlier backup.
function defaultExportPath(): string {
  const home = ensureHome(resolveCairnHome());
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(home, `cairn-export-${stamp}.zip`);
}

// export_memories is reachable by ordinary mistaken or prompt-injected model
// behaviour (the tool description itself invites a path), so its writes are
// confined to the Cairn home -- unlike a future human-driven CLI export
// command, which could reasonably write anywhere the human chooses. The
// difference is who chose the path. Mirrors the prefix check in
// src/dashboard/assets.ts: compare with a separator-terminated prefix, not a
// bare startsWith, so a sibling directory like "<home>-evil" cannot pass.
// import_memories takes an unconfined path (unlike export_memories, this one
// is human-driven -- restoring a backup from wherever the user put it), so
// it must not become a filesystem oracle: one fixed, path-free message for
// every "nothing readable here" outcome (see below), and a size ceiling
// checked with `statSync` before `readFileSync` ever loads the file into
// memory.
const IMPORT_NO_ARCHIVE_MESSAGE = "import_memories: no readable archive at that path";
const MAX_IMPORT_ARCHIVE_BYTES = 200 * 1024 * 1024;

// Defence in depth for BUILD_BRIEF §10/§12: every error site an import
// archive can reach (this file's own throws, archive.ts, and the storage
// layer's importMemory) has been reviewed to bound attacker-controlled text
// -- but a future one that isn't would otherwise flow straight into an MCP
// client's context unbounded. This is the outer net, not a substitute for
// bounding at the source: it clamps whatever message is ABOUT to leave a
// tool result, however it got long.
const CAUGHT_ERROR_MESSAGE_LIMIT = 200;
function clampErrorMessage(message: string): string {
  return message.length > CAUGHT_ERROR_MESSAGE_LIMIT
    ? `${message.slice(0, CAUGHT_ERROR_MESSAGE_LIMIT)}…`
    : message;
}

// The systemic version of the same net: an audit found six of the eight
// tools (remember, recall, get_context, list_memories, update_memory,
// forget) had NO catch block at all, so anything thrown below them -- e.g.
// paging.ts's decodeCursor on a malformed cursor -- reached the MCP client
// verbatim and unbounded. Rather than add six near-identical try/catch
// blocks that will inevitably drift apart, every tool handler is wrapped
// here, in one place, so no future tool can be added without this net.
// Mutating `err.message` in place (instead of constructing a new Error)
// preserves the thrown value's real type and identity -- callers/tests that
// `instanceof`-match a specific error class, and the per-tool catch blocks
// above (import_memories's ArchiveFormatError collapse, recall/get_context's
// degradedReason scrub, export_memories's fixed messages) still run first
// and produce whatever message they choose; this only clamps it further if
// it is somehow still too long, it never replaces it.
function withBoundedErrors<Args extends unknown[]>(
  handler: (...args: Args) => CallToolResult | Promise<CallToolResult>,
): (...args: Args) => Promise<CallToolResult> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof Error) {
        err.message = clampErrorMessage(err.message);
      }
      throw err;
    }
  };
}

// Every ArchiveFormatError archive.ts can raise BEFORE manifest.json has been
// parsed and its formatVersion read (see importArchive there): a real ZIP
// that just isn't a Cairn archive at all (e.g. a .jar/.docx/.xlsx/.apk/.epub)
// falls in here. These must collapse to IMPORT_NO_ARCHIVE_MESSAGE below --
// otherwise this call site is a filesystem oracle over every zip-container
// file on the machine, not just Cairn archives. Anything raised AFTER that
// point (unsupported format version, checksum mismatch, ...) proves the
// caller already had a real Cairn archive, so it keeps its own message.
const PRE_MANIFEST_ARCHIVE_ERRORS: RegExp[] = [
  /^not a valid Cairn archive:/,
  /^archive is missing manifest\.json$/,
  /^manifest\.json is not valid JSON$/,
  /^manifest\.json is not a JSON object$/,
  /^manifest\.json is missing a numeric formatVersion$/,
];

function resolveWithinCairnHome(requested: string): string {
  const home = resolve(ensureHome(resolveCairnHome()));
  const candidate = resolve(home, requested);
  if (candidate !== home && !candidate.startsWith(home + sep)) {
    throw new Error("export_memories: path must be inside the Cairn home directory");
  }
  return candidate;
}

// resolveWithinCairnHome's containment check is purely lexical (plain
// `resolve()`), so it never sees a symlink in a PARENT component of the
// candidate path -- a directory under the home that is actually a symlink
// out of it passes that check untouched. `wx` on the final write only
// defeats a symlink at the target FILE itself (dangling or pointing at an
// existing file); it says nothing about the directory the file would be
// created in. This is the additional gate: resolve the candidate's real
// parent directory and re-check containment against that.
function verifyExportDirNotSymlinkedOutOfHome(candidate: string): void {
  const home = resolve(ensureHome(resolveCairnHome()));
  let realDir: string;
  try {
    realDir = realpathSync(dirname(candidate));
  } catch {
    throw new Error("export_memories: path must be inside the Cairn home directory");
  }
  if (realDir !== home && !realDir.startsWith(home + sep)) {
    throw new Error("export_memories: path must be inside the Cairn home directory");
  }
}

// Being inside the Cairn home is necessary but not sufficient: the database
// itself (and its WAL/SHM siblings) and the daemon's runtime file also live
// there, and export_memories writing to any of THOSE names would truncate
// the live store or the running daemon's rendezvous file instead of
// producing a backup. Refuse those exact paths by identity, using the same
// helpers the daemon uses to find them, rather than hardcoding filenames
// that could drift out of sync.
//
// A bare string-identity check against `candidate` is bypassable: a
// trailing space or dot in the requested name (e.g. "cairn.db ") makes
// `candidate` a distinct string on Linux, but Windows' filesystem strips
// trailing spaces/dots so that name still resolves to the live database
// there -- and a `:` introduces an NTFS alternate data stream (e.g.
// "cairn.db:evil") whose non-existence would otherwise let `wx` succeed.
// So this compares the final path segment, with trailing dots/spaces
// stripped, against the protected names, and refuses any `:` outright.
const PROTECTED_HOME_FILENAMES = new Set(["cairn.db", "cairn.db-wal", "cairn.db-shm", "daemon.json"]);

function refuseCairnOwnedPath(candidate: string): void {
  const home = resolveCairnHome();
  const db = dbPath(home);
  const forbidden = new Set([db, `${db}-wal`, `${db}-shm`, runtimeFilePath(home)]);
  if (forbidden.has(candidate)) {
    throw new Error("export_memories: path must be inside the Cairn home directory");
  }
  const base = basename(candidate);
  if (base.includes(":")) {
    throw new Error("export_memories: path must be inside the Cairn home directory");
  }
  const normalizedBase = base.replace(/[. ]+$/, "");
  if (PROTECTED_HOME_FILENAMES.has(normalizedBase)) {
    throw new Error("export_memories: path must be inside the Cairn home directory");
  }
}

/**
 * Registers exactly the eight §6 tools on `server`, wired to `deps`.
 */
export function registerTools(server: McpServer, deps: McpDeps, resourceEvents: ResourceEvents): void {
  function nowOverride(): number | undefined {
    return deps.now ? deps.now() : undefined;
  }

  // Resources are the mirror of the store (§6); a mutation must tell
  // resource-capable clients the list changed, and -- when it names one
  // memory -- that the specific memory resource changed too. Reads never
  // call this.
  async function notifyMutation(memoryId?: string): Promise<void> {
    resourceEvents.notifyListChanged();
    if (memoryId) {
      await resourceEvents.notifyUpdated(memoryUri(memoryId));
    }
  }

  // exportArchive/importArchive (portability/archive.ts) always call the
  // store with their own fixed administrative CallContext, never the real
  // connected client's -- so store.list/importMemory's own gate() never
  // sees THIS client's identity and can't refuse a paused one. A cheap
  // gated read first (store.list, limit 1) closes that gap: it throws
  // before either tool below touches the filesystem or the archive if this
  // client is disabled (§9).
  function requireEnabled(scope: string | undefined): void {
    deps.store.list({ scope, limit: 1 }, callContext(server, scope));
  }

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Store a new memory. Call this whenever the user states a durable preference, decision, personal " +
        "fact, or correction -- anything that should still be true and recoverable in a future conversation, " +
        "in this app or a different one. Example: the user says \"I prefer TypeScript over JavaScript for new " +
        'projects" -- call remember(content: "User prefers TypeScript over JavaScript for new projects.") ' +
        "right away, do not wait to be asked. Never calls an LLM or the network: this is a local, instant " +
        "write. Accepts `text` as an alias for `content`.",
      inputSchema: {
        content: z.string().optional().describe("The memory text to store. Required (or its alias `text`)."),
        text: z.string().optional().describe("Alias for `content`."),
        tags: z.array(z.string()).optional().describe('Free-form labels for filtering later, e.g. ["preference", "editor"].'),
        scope: z.string().optional().describe('Namespace to store under, e.g. a project name. Defaults to "default".'),
        source: z
          .string()
          .optional()
          .describe(
            'Optional free-text note on where this came from (e.g. "user said", "inferred"). Stored as ' +
              "provenance alongside the episode, not used for retrieval.",
          ),
        importance: numberOrNumericString
          .optional()
          .describe(
            "0 (trivial) to 1 (critical). Defaults to 0.5. Out-of-range or non-numeric values are clamped into " +
              "range, never rejected.",
          ),
      },
    },
    withBoundedErrors(async (args) => {
      const content = firstNonEmpty(args.content, args.text);
      if (!content) {
        throw new Error("remember requires `content` (or its alias `text`) with non-empty text.");
      }
      // `remember` never calls an LLM or the network (BUILD_BRIEF §2): it
      // stores the episode and the fact synchronously; a background
      // indexer embeds later, out-of-band. Do not add an `await embed(...)`
      // on this path, no matter how tempting a "smarter write" looks.
      const { memory, deduped, episodeId } = deps.store.remember(
        {
          content,
          tags: args.tags,
          scope: args.scope,
          importance: clampUnit(args.importance, 0.5),
          metadata: args.source ? { source: args.source } : undefined,
        },
        callContext(server, args.scope),
      );
      await notifyMutation(memory.id);
      return jsonResult({ id: memory.id, deduped, episodeId });
    }),
  );

  server.registerTool(
    "recall",
    {
      title: "Recall",
      description:
        "Search stored memories by meaning and keywords. Call this BEFORE answering anything that may depend " +
        "on prior context -- the user's preferences, past decisions, project facts, or anything they told a " +
        'different MCP client earlier. Example: before answering "what database did we pick?", call ' +
        'recall(query: "database choice") first instead of guessing or asking again. Accepts `q` or `text` as ' +
        "aliases for `query`.",
      inputSchema: {
        query: z.string().optional().describe("What to search for. Required (or its aliases `q`/`text`)."),
        q: z.string().optional().describe("Alias for `query`."),
        text: z.string().optional().describe("Alias for `query`."),
        limit: numberOrNumericString
          .optional()
          .describe(
            "Max results to return. Defaults to 10, capped at 50. Out-of-range or non-numeric values are " +
              "clamped, never rejected.",
          ),
        scope: z.string().optional().describe("Restrict the search to one namespace, e.g. a project name."),
        tags: z.array(z.string()).optional().describe("Only return memories carrying ALL of these tags."),
      },
    },
    withBoundedErrors(async (args) => {
      const query = firstNonEmpty(args.query, args.q, args.text);
      if (!query) {
        throw new Error("recall requires `query` (or its aliases `q`/`text`) with non-empty text.");
      }
      const result = await deps.store.recall(
        query,
        {
          scope: args.scope,
          tags: args.tags,
          limit: clampInt(args.limit, 1, 50, 10),
          now: nowOverride(),
          provider: deps.provider ?? null,
          space: deps.space ?? null,
        },
        callContext(server, args.scope),
      );
      return jsonResult({
        hits: result.hits.map(hitToJson),
        degraded: result.degraded,
        degradedReason: toSafeDegradedReason(result.degraded, result.degradedReason),
      });
    }),
  );

  server.registerTool(
    "get_context",
    {
      title: "Get context",
      description:
        "Return one budgeted block (~800 tokens by default) of the most relevant memories, ready to paste " +
        "into context. Call this BEFORE answering anything that may depend on prior context, especially at " +
        "the start of a session -- instead of dumping the whole memory store, which pollutes context. " +
        "Example: at the start of a conversation, call get_context() with no query for a budgeted index of " +
        'what matters right now, or get_context(query: "deployment process") for a specific question. ' +
        "Accepts `q` or `text` as aliases for `query`.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("What the upcoming turn is about. Omit for a general 'what matters right now' index. Aliases: `q`, `text`."),
        q: z.string().optional().describe("Alias for `query`."),
        text: z.string().optional().describe("Alias for `query`."),
        token_budget: numberOrNumericString
          .optional()
          .describe(
            "Approximate max size of the returned block, in tokens. Defaults to ~800 -- never raise this to " +
              '"get everything", that defeats the point of a budgeted block. Values below 1 or non-numeric are ' +
              "clamped/defaulted, never rejected.",
          ),
        scope: z.string().optional().describe("Restrict to one namespace."),
        tags: z.array(z.string()).optional().describe("Only include memories carrying ALL of these tags."),
      },
    },
    withBoundedErrors(async (args) => {
      const query = firstNonEmpty(args.query, args.q, args.text) ?? "";
      const block = await deps.store.context(
        query,
        {
          scope: args.scope,
          tags: args.tags,
          tokenBudget: clampIntMin(args.token_budget, 1),
          now: nowOverride(),
          provider: deps.provider ?? null,
          space: deps.space ?? null,
        },
        callContext(server, args.scope),
      );
      return jsonResult({
        text: block.text,
        memories: block.memories.map(hitToJson),
        tokensEstimated: block.tokensEstimated,
        truncated: block.truncated,
        degraded: block.degraded,
        degradedReason: toSafeDegradedReason(block.degraded, block.degradedReason),
      });
    }),
  );

  server.registerTool(
    "list_memories",
    {
      title: "List memories",
      description:
        "Browse stored memories with pagination -- for auditing, curating, or finding a memory to update or " +
        "forget when a fuzzy recall search is not precise enough. Example: list_memories(scope: \"work\", " +
        'limit: 20) to see the most recent memories in a scope, then page further with the returned ' +
        "`nextCursor`. Not for answering a question -- call recall or get_context for that instead. Pass " +
        "`include_deleted: true` to review memories the user has forgotten (e.g. to undo one) -- omitted by " +
        "default, since a forgotten memory should stay out of sight otherwise.",
      inputSchema: {
        scope: z.string().optional().describe("Restrict to one namespace."),
        tags: z.array(z.string()).optional().describe("Only return memories carrying ALL of these tags."),
        cursor: z.string().optional().describe("Opaque pagination cursor from a previous call's `nextCursor`."),
        limit: numberOrNumericString
          .optional()
          .describe(
            "Page size. Defaults to 50, capped at 200. Out-of-range or non-numeric values are clamped, never " +
              "rejected.",
          ),
        include_deleted: z
          .boolean()
          .optional()
          .describe(
            "Include soft-deleted (forgotten) memories, for reviewing what was forgotten or undoing a forget. " +
              "Defaults to false. Alias: `includeDeleted`.",
          ),
        includeDeleted: z.boolean().optional().describe("Alias for `include_deleted`."),
        include_superseded: z
          .boolean()
          .optional()
          .describe(
            "Include memories superseded by a newer fact (BUILD_BRIEF §5's temporal supersede-not-delete). " +
              "Defaults to false. Alias: `includeSuperseded`.",
          ),
        includeSuperseded: z.boolean().optional().describe("Alias for `include_superseded`."),
      },
    },
    withBoundedErrors((args) => {
      const result = deps.store.list(
        {
          scope: args.scope,
          tags: args.tags,
          cursor: args.cursor ?? null,
          limit: clampInt(args.limit, 1, 200, 50),
          includeDeleted: firstBoolean(args.include_deleted, args.includeDeleted),
          includeSuperseded: firstBoolean(args.include_superseded, args.includeSuperseded),
        },
        callContext(server, args.scope),
      );
      return jsonResult({ items: result.items.map(memoryToJson), nextCursor: result.nextCursor });
    }),
  );

  server.registerTool(
    "update_memory",
    {
      title: "Update memory",
      description:
        "Edit an existing memory's content, tags, or importance. Call this when the user corrects or refines " +
        "something already stored, instead of creating a duplicate with remember. Example: the user says " +
        '"actually, make that more important" -- call update_memory(id: "...", importance: 0.9). Accepts ' +
        "`text` as an alias for `content`.",
      inputSchema: {
        id: z.string().min(1).describe("The memory id to edit, from a previous remember/recall/list_memories call."),
        content: z.string().optional().describe("New text, replacing the old. Alias: `text`."),
        text: z.string().optional().describe("Alias for `content`."),
        tags: z.array(z.string()).optional().describe("Replaces the memory's tags entirely."),
        importance: numberOrNumericString
          .optional()
          .describe(
            "Replaces the memory's importance, 0 to 1. Out-of-range or non-numeric values are clamped into " +
              "range, never rejected. Omit to leave importance unchanged.",
          ),
      },
    },
    withBoundedErrors(async (args) => {
      const content = firstNonEmpty(args.content, args.text);
      const memory = deps.store.update(
        args.id,
        { text: content, tags: args.tags, importance: clampUnitOptional(args.importance) },
        callContext(server),
      );
      await notifyMutation(memory.id);
      return jsonResult(memoryToJson(memory));
    }),
  );

  server.registerTool(
    "forget",
    {
      title: "Forget",
      description:
        "Delete a memory. Call this when the user explicitly asks to forget, delete, or remove something they " +
        "told you. With an `id`, deletes that one memory immediately (soft-delete, reversible). With a " +
        "`query` and no `confirm: true`, this ONLY PREVIEWS what would be deleted and deletes NOTHING -- call " +
        "it again with `confirm: true` after the user confirms the preview to actually delete. Example: the " +
        'user says "forget what I told you about my old job" -- call forget(query: "old job") to see the ' +
        'preview, confirm with the user, then call forget(query: "old job", confirm: true). SAFEST form: pass ' +
        "back the `ids` the preview returned alongside `confirm: true` -- forget(ids: [...], confirm: true) -- " +
        "so the delete removes exactly what the user saw, even if another client wrote or changed memories in " +
        "between. Accepts `q` or `text` as aliases for `query`.",
      inputSchema: {
        id: z.string().optional().describe("The exact memory id to delete. Provide this OR `query`, not both."),
        query: z
          .string()
          .optional()
          .describe(
            'Text describing what to forget, e.g. "my old job". Aliases: `q`, `text`. Without `confirm: ' +
              "true`, only PREVIEWS matches and deletes nothing.",
          ),
        q: z.string().optional().describe("Alias for `query`."),
        text: z.string().optional().describe("Alias for `query`."),
        scope: z.string().optional().describe("Restrict the `query` search to one namespace."),
        ids: z
          .array(z.string())
          .optional()
          .describe(
            "Exact memory ids to delete, taken from a previous preview's `ids`/`wouldDelete`. Requires " +
              "`confirm: true`. This is the SAFE form of confirm: it deletes exactly these ids instead of " +
              "re-running the search, so nothing written or reordered after the preview can be swept in.",
          ),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Must be `true` to actually delete. Combine with `ids` (safe: deletes exactly those ids) or with " +
              "`query` alone (re-runs the search and deletes its current results). Not needed when deleting by `id`.",
          ),
      },
    },
    withBoundedErrors(async (args) => {
      if (args.id) {
        const deleted = deps.store.forget(args.id, callContext(server, args.scope));
        if (deleted) {
          await notifyMutation(args.id);
        }
        return jsonResult({ deleted, id: args.id });
      }

      // The safe confirmed form: delete exactly the previewed ids, one at
      // a time through the same gated/audited store.forget(id) as the
      // by-id branch above -- never re-run the search, which could pick up
      // a memory written by a different client after the user saw the
      // preview (BUILD_BRIEF §9: many clients, one store).
      if (args.confirm === true && args.ids !== undefined) {
        const deletedIds: string[] = [];
        for (const id of args.ids) {
          const ok = deps.store.forget(id, callContext(server, args.scope));
          if (ok) deletedIds.push(id);
        }
        if (deletedIds.length > 0) {
          resourceEvents.notifyListChanged();
          for (const id of deletedIds) {
            await resourceEvents.notifyUpdated(memoryUri(id));
          }
        }
        return jsonResult({ deleted: deletedIds.length > 0, count: deletedIds.length, ids: deletedIds });
      }

      const query = firstNonEmpty(args.query, args.q, args.text);
      if (!query) {
        throw new Error(
          "forget requires `id` (delete one memory), `query` (find memories to delete), or `confirm: true` " +
            "with the `ids` from a previous preview.",
        );
      }

      const result = await deps.store.forgetWhere(
        query,
        { scope: args.scope, confirm: args.confirm === true },
        callContext(server, args.scope),
      );

      // Safety property: a query-shaped forget NEVER deletes without an
      // explicit confirm -- a model mis-firing this call must not silently
      // erase memories.
      if (!args.confirm) {
        return jsonResult({
          deleted: false,
          count: 0,
          ids: result.matches.map((m) => m.id),
          wouldDelete: result.matches,
          message:
            result.matches.length === 0
              ? "No memories matched this query; nothing would be deleted."
              : `Found ${result.matches.length} matching ${result.matches.length === 1 ? "memory" : "memories"}. Nothing ` +
                `has been deleted. Call forget again with confirm: true and these ids to actually delete ` +
                `${result.matches.length === 1 ? "it" : "them"}.`,
        });
      }

      if (result.count > 0) {
        resourceEvents.notifyListChanged();
        for (const match of result.matches) {
          await resourceEvents.notifyUpdated(memoryUri(match.id));
        }
      }
      return jsonResult({ deleted: result.deleted, count: result.count, ids: result.matches.map((m) => m.id) });
    }),
  );

  server.registerTool(
    "export_memories",
    {
      title: "Export memories",
      description:
        "Back up or move the user's whole memory store to a file on disk. Call this when the user asks to " +
        'back up, export, or move their memory to another machine. Example: the user says "back up my ' +
        'memories before I reset my laptop" -- call export_memories(path: "backup.zip") (or omit `path` for ' +
        "a timestamped default under the Cairn home). Returns the file's path, size, and counts -- never the " +
        "memory contents themselves, so a large store never floods this response.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("Where to write the archive. Defaults to a timestamped file under the Cairn home."),
        scope: z.string().optional().describe("Export only one namespace instead of every scope."),
      },
    },
    withBoundedErrors((args) => {
      requireEnabled(args.scope);
      const path =
        args.path && args.path.trim().length > 0
          ? resolveWithinCairnHome(args.path)
          : defaultExportPath();
      verifyExportDirNotSymlinkedOutOfHome(path);
      refuseCairnOwnedPath(path);
      // includeSuperseded: true -- otherwise listMemories' default
      // `valid_until IS NULL` filter silently drops every superseded row,
      // and with it the §5/§7 temporal history (a supersede's old value and
      // its `validUntil`/`supersededBy` pointer) this "backup" is supposed
      // to preserve. Soft-deleted rows are left out (includeDeleted stays
      // false): a memory the user has forgotten, especially one past its
      // undo window, is not part of the store a backup is meant to restore.
      const result = exportArchive(deps.store, { scope: args.scope, includeSuperseded: true });
      try {
        writeFileSync(path, result.archive, { flag: "wx" });
      } catch (err) {
        const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
        if (code === "EEXIST") {
          throw new Error("export_memories: refuses to overwrite an existing file");
        }
        throw new Error("export_memories: failed to write the archive");
      }
      recordAudit(deps.store.db, {
        action: "export",
        scope: args.scope ?? null,
        sourceClient: callContext(server, args.scope).sourceClient,
        details: { path, bytes: result.archive.length, memories: result.memories, episodes: result.episodes },
      });
      return jsonResult({
        path,
        bytes: result.archive.length,
        memories: result.memories,
        episodes: result.episodes,
      });
    }),
  );

  server.registerTool(
    "import_memories",
    {
      title: "Import memories",
      description:
        "Merge memories from a previously exported archive file into the store. This MERGES -- it never " +
        "replaces or overwrites anything: a memory whose id or content is already present is skipped, so " +
        "importing the same archive twice is safe and imports nothing the second time. Call this when the " +
        'user asks to restore a backup or bring memories over from another machine. Example: the user says ' +
        '"load the memories I exported from my old laptop" -- call import_memories(path: "backup.zip"). ' +
        "Never present this as a destructive restore; it is additive only.",
      inputSchema: {
        path: z.string().min(1).describe("Path to a Cairn export archive (.zip) previously written by export_memories."),
        scope: z.string().optional().describe("Attributed scope for this import call's own audit entry."),
      },
    },
    withBoundedErrors(async (args) => {
      requireEnabled(args.scope);
      const path = resolve(args.path);
      let archiveBuf: Buffer;
      try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > MAX_IMPORT_ARCHIVE_BYTES) {
          throw new Error(IMPORT_NO_ARCHIVE_MESSAGE);
        }
        archiveBuf = readFileSync(path);
      } catch {
        // Collapsed to one fixed, path-free string on purpose (BUILD_BRIEF
        // §10): a nonexistent path, a directory, and an unreadable file are
        // each an ordinary "no archive here" outcome to the caller, not
        // three distinguishable ones -- letting them differ turns this tool
        // into an existence-and-readability oracle over the filesystem for
        // any connected MCP client.
        throw new Error(IMPORT_NO_ARCHIVE_MESSAGE);
      }
      let result: { imported: number; skipped: number; memories: number };
      try {
        result = importArchive(deps.store, archiveBuf);
      } catch (err) {
        // A file that reads fine but isn't a ZIP at all (e.g. /etc/shadow),
        // or a real ZIP that isn't a Cairn archive (e.g. a .jar/.docx),
        // is the same "no archive here" outcome as the two filesystem cases
        // above, for the same oracle reason -- collapse it to the identical
        // message. A real archive that fails deeper validation (checksum
        // mismatch, unsupported format version, ...) proves the caller COULD
        // read a real Cairn archive at that path, so it keeps its own message.
        if (err instanceof ArchiveFormatError) {
          const isPreManifest = PRE_MANIFEST_ARCHIVE_ERRORS.some((re) => re.test(err.message));
          throw new Error(
            isPreManifest ? IMPORT_NO_ARCHIVE_MESSAGE : clampErrorMessage(`import_memories: ${err.message}`),
          );
        }
        throw new Error(clampErrorMessage(err instanceof Error ? err.message : String(err)));
      }
      recordAudit(deps.store.db, {
        action: "import",
        scope: args.scope ?? null,
        sourceClient: callContext(server, args.scope).sourceClient,
        details: { path, imported: result.imported, skipped: result.skipped },
      });
      if (result.imported > 0) {
        await notifyMutation();
      }
      return jsonResult({ imported: result.imported, skipped: result.skipped });
    }),
  );
}
