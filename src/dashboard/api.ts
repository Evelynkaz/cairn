// The whole `/api` namespace the dashboard SPA talks to (BUILD_BRIEF §9,
// §13). Deliberately its own module, not wired into the daemon here -- a
// later step does that (see src/daemon/server.ts). Reuses the HTTP
// primitives from ../daemon/http.js rather than re-implementing the body
// cap or the constant-time token comparison a second time.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../storage/index.js";
import { DEFAULT_SCOPE, VALID_PRIVACY_MODES } from "../storage/index.js";
import type { PrivacyMode } from "../storage/index.js";
import type { MemoryEvent, MemoryEventBus } from "../mcp/events.js";
import { PayloadTooLargeError, readJsonBody, sendJson, tokenMatches } from "../daemon/http.js";
import { DASHBOARD_CLIENT } from "../config/identity.js";
import { LiveTextCollisionError } from "../storage/repositories/memories.js";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "../storage/repositories/paging.js";
import { extractCustomInstructions, ImporterFormatError, parsePastedMemories } from "../portability/importers/index.js";
import { toSafeDegradedReason } from "../retrieval/search.js";
import { MAX_TAGS, MAX_TAG_LENGTH, MAX_SCOPE_LENGTH } from "../storage/limits.js";
import { redactText } from "../privacy/redact.js";
import { contentHash } from "../util/text.js";

// Re-exported for callers that already import it from here.
export { DASHBOARD_CLIENT };

export interface DashboardApiDeps {
  store: Store;
  /** The daemon's bearer token; every /api route requires it. */
  token: string;
  /** Shared mutation fan-out; when absent, /api/events still works and simply never emits. */
  bus?: MemoryEventBus;
  now?: () => number;
}

export interface DashboardApi {
  /** Returns true if it handled the request (the path is "/api" or under "/api/"),
      false if the caller should keep routing. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** Ends every open SSE stream and clears every timer. */
  close(): void;
}

const CTX = { sourceClient: DASHBOARD_CLIENT };

// Same identity as CTX, but stamps every write 'import' rather than the
// silent 'user' default (see storage/store.ts's CallContext.origin doc) --
// used by handleImportPasted and handleImportChatGpt below, the only two
// routes in this file writing text that did not come from the user typing
// it themselves. Without this, a memory pasted out of a ChatGPT export
// would be indistinguishable from one the user typed, and would be
// auto-injected into a session's highest-trust position exactly like the
// prompt-injection channel two audits demonstrated (see context.ts).
const IMPORT_CTX = { sourceClient: DASHBOARD_CLIENT, origin: "import" as const };

// How often an SSE stream sends a heartbeat comment, keeping the
// connection alive across proxies/load balancers that drop an idle one.
const SSE_HEARTBEAT_INTERVAL_MS = 25_000;
// Bounds how many dashboard tabs/windows can hold an SSE connection open at
// once, for the same reason server.ts caps MCP sessions: an unbounded
// number of long-lived connections is an unbounded resource leak.
const MAX_SSE_STREAMS = 50;
const MAX_BULK_IDS = 200;
// Caps how much an individual SSE stream's write buffer is allowed to grow
// when its consumer is not draining it (a suspended tab, a sleeping
// laptop, `curl | head`) -- see the backpressure handling in handleEvents.
const SSE_BACKPRESSURE_CAP_BYTES = 1024 * 1024;

// The only discriminator an error body ever carries (see handlePatchMemory,
// handleRestoreMemory, handleSupersedeMemory and handleApproveMemory below):
// drawn from which code path threw, never from an error's own message, so a
// client can tell "this memory is history" apart from "that text already
// exists elsewhere" apart from "the store refused this write in strict mode"
// apart from "the store is read-only" without anything user-supplied ever
// leaking into the enum.
type ErrorReason = "superseded" | "duplicate_text" | "strict_redaction_refused" | "read_only";

class HttpError extends Error {
  readonly status: number;
  readonly reason?: ErrorReason;
  constructor(status: number, message: string, reason?: ErrorReason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

function parseListParam(url: URL, name: string): string[] | undefined {
  // Tags may arrive as one repeated query param (?tags=a&tags=b) or as one
  // comma-separated value (?tags=a,b) -- both are accepted per the spec.
  const values = url.searchParams.getAll(name);
  if (values.length === 0) return undefined;
  const flat = values.flatMap((v) => v.split(","));
  const trimmed = flat.map((v) => v.trim()).filter((v) => v.length > 0);
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseIntParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseBoolParam(url: URL, name: string): boolean | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  return raw === "1" || raw === "true";
}

function parseStringParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  return raw === null ? undefined : raw;
}

// Like parseIntParam, but a present, non-blank, non-numeric value is a
// client mistake (a hand-typed filter, a stale bookmark) and must be
// rejected with 400 rather than silently treated as "no filter" -- unlike
// parseIntParam's callers elsewhere, which already tolerate that.
function parseRequiredIntParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new HttpError(400, `${name} must be numeric`);
  }
  return n;
}

// Turns the repository's "malformed ... cursor" throw into a 400 instead
// of letting it fall into the generic 500 handler -- a bad cursor is a
// client mistake (a stale bookmark, a hand-edited URL), not a server fault.
function isMalformedCursorError(err: unknown): boolean {
  return err instanceof Error && /malformed .*cursor/i.test(err.message);
}

// Matches ONLY store.remember's strict-mode refusal (src/storage/store.ts),
// whose message is a fixed prefix followed by kind names and counts, never
// a value or a preview -- so testing the prefix here is safe and does not
// forward anything user-supplied. Any other throw (e.g. a disabled client,
// a read-only store) is a genuine failure and must still propagate.
function isStrictRedactionRefusal(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("remember refused: found ");
}

// Matches ONLY Store's requireWritable() refusal (src/storage/store.ts),
// whose message is a fixed "store opened read-only: cannot call X()" with
// no request- or memory-derived content -- safe to test the prefix here,
// same reasoning as isStrictRedactionRefusal above.
function isReadOnlyRefusal(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("store opened read-only");
}

// The fixed 400 body for isStrictRedactionRefusal above, wired into every
// write path below that can reach a strict-mode refusal: names the
// situation and the mode, never the offending value or the detected secret
// (§10) -- unlike err.message, which is never forwarded here.
const STRICT_REDACTION_REFUSAL_MESSAGE =
  "this write was refused: the text appears to contain a secret and privacy mode is set to strict";

// Shared by the memory patch and supersede handlers: `importance` is a
// 0..1 relevance weight (BUILD_BRIEF §7's re-rank), so anything else --
// out of range or not a number at all -- is a client mistake, not a store
// failure, and must be rejected with 400 before it ever reaches the store.
function validateImportance(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new HttpError(400, "importance must be a number between 0 and 1");
  }
  return value;
}

// A pasted import's `tags` array is re-applied to EVERY entry parsed out of
// `text` (handleImportPasted below), so nothing here bounding array length
// or per-tag length means N entries x unbounded tags becomes unbounded rows
// -- measured at 500 entries x 2000 tags = 1,000,000 tag rows from a single
// ~25 KB request, blocking the single-threaded daemon for minutes. Also
// shared by every other write path in this file that accepts a caller-
// supplied `tags` array (PATCH, supersede) for the same reason. A cap is
// refused with a fixed 400 rather than silently truncated, so a paste that
// looks like it worked never silently drops the user's own tags. The limit
// numbers themselves live in ../storage/limits.js, imported by both this
// file and store.ts, so the two enforcement sites can never drift apart the
// way they already have once.

function clampTags(tags: unknown[]): string[] {
  if (tags.length > MAX_TAGS) {
    throw new HttpError(400, `tags exceeds the cap of ${MAX_TAGS}`);
  }
  const mapped = tags.map(String);
  if (mapped.some((t) => t.length > MAX_TAG_LENGTH)) {
    throw new HttpError(400, `each tag must be at most ${MAX_TAG_LENGTH} characters`);
  }
  return mapped;
}

function clampScope(scope: string): string {
  if (scope.length > MAX_SCOPE_LENGTH) {
    throw new HttpError(400, `scope exceeds the cap of ${MAX_SCOPE_LENGTH} characters`);
  }
  return scope;
}

// How many of a preview's would-be-created entries are shown, same bound
// as list_memories's own default page (paging.ts's DEFAULT_PAGE_LIMIT) --
// a preview is a read like any other and must stay just as bounded as one
// (BUILD_BRIEF §12), even though the underlying paste can hold up to
// MAX_PASTED_ENTRIES (pasted.ts). `wouldImport` still reports the true
// total; only the entry TEXT list is capped.
const IMPORT_PREVIEW_ENTRY_LIMIT = DEFAULT_PAGE_LIMIT;

// Bounds how many pages of the store's own list() this module will walk
// to build a duplicate-check hash set for one preview -- list()'s own
// per-page cap (MAX_PAGE_LIMIT) times this is the most live memories in one
// scope a single preview will ever compare against; beyond that, a
// duplicate against a memory outside this window is simply reported as new
// rather than blocking the preview on an unbounded scan (BUILD_BRIEF §12
// bounds every tool's output, and this is a read on every one of them).
const IMPORT_PREVIEW_HASH_SCAN_PAGE_CAP = 50;

interface ImportPreview {
  entries: { text: string }[];
  entriesTruncated: boolean;
  wouldImport: number;
  wouldSkipDuplicate: number;
  wouldRefuseStrict: number;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "expected a JSON object body");
  }
  return body as Record<string, unknown>;
}

export function createDashboardApi(deps: DashboardApiDeps): DashboardApi {
  const { store, token, bus } = deps;
  const now = deps.now ?? Date.now;

  interface SseStream {
    res: ServerResponse;
    unsubscribe: () => void;
    heartbeat: NodeJS.Timeout;
  }
  const sseStreams = new Set<SseStream>();

  function endStream(stream: SseStream): void {
    sseStreams.delete(stream);
    clearInterval(stream.heartbeat);
    stream.unsubscribe();
    if (!stream.res.writableEnded) {
      stream.res.end();
    }
  }

  function authorize(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    const prefix = "Bearer ";
    const provided = typeof header === "string" && header.startsWith(prefix) ? header.slice(prefix.length) : null;
    return provided !== null && tokenMatches(provided, token);
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    try {
      return await readJsonBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        throw new HttpError(413, "request body too large");
      }
      throw new HttpError(400, "invalid JSON body");
    }
  }

  function requireId(segments: string[], index: number): string {
    const id = segments[index];
    if (!id) {
      throw new HttpError(404, "not found");
    }
    return id;
  }

  async function handleStats(res: ServerResponse, url: URL): Promise<void> {
    const topLimit = parseIntParam(url, "topLimit");
    const stats = store.stats({ topLimit, now });
    sendJson(res, 200, {
      ...stats,
      vectors: store.capabilities.vectors,
      journalMode: store.capabilities.journalMode,
      redactions: store.redactionStats(),
    });
  }

  async function handleListMemories(res: ServerResponse, url: URL): Promise<void> {
    const scope = parseStringParam(url, "scope");
    const tags = parseListParam(url, "tags");
    const q = parseStringParam(url, "q");
    const limit = parseIntParam(url, "limit");
    const cursor = parseStringParam(url, "cursor") ?? null;
    const includeDeleted = parseBoolParam(url, "includeDeleted");
    const includeSuperseded = parseBoolParam(url, "includeSuperseded");
    const sourceClient = parseStringParam(url, "sourceClient");
    const since = parseRequiredIntParam(url, "since");
    const until = parseRequiredIntParam(url, "until");

    if (q !== undefined && q.trim() !== "") {
      const result = await store.recall(q, { scope, tags, limit }, CTX);
      sendJson(res, 200, {
        mode: "search",
        hits: result.hits,
        degraded: result.degraded,
        degradedReason: toSafeDegradedReason(result.degraded),
      });
      return;
    }

    const result = store.list(
      { scope, tags, sourceClient, since, until, includeDeleted, includeSuperseded, limit, cursor },
      CTX,
    );
    sendJson(res, 200, { mode: "list", items: result.items, nextCursor: result.nextCursor });
  }

  async function handleGetMemory(res: ServerResponse, url: URL, id: string): Promise<void> {
    const includeDeleted = parseBoolParam(url, "includeDeleted");
    const includeSuperseded = parseBoolParam(url, "includeSuperseded");
    const memory = store.get(id, { includeDeleted, includeSuperseded }, CTX);
    if (!memory) {
      throw new HttpError(404, "not found");
    }
    sendJson(res, 200, memory);
  }

  async function handlePatchMemory(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const body = asRecord(await readBody(req));
    const patch: { text?: string; tags?: string[]; importance?: number } = {};
    if (typeof body["text"] === "string") patch.text = body["text"];
    if (Array.isArray(body["tags"])) patch.tags = clampTags(body["tags"]);
    if (body["importance"] !== undefined) patch.importance = validateImportance(body["importance"]);
    const current = store.get(id, { includeDeleted: true, includeSuperseded: true }, CTX);
    if (!current) {
      throw new HttpError(404, "not found");
    }
    // A superseded memory is history (§5): editing it is a request the
    // store's rules forbid, not a server fault -- answer it as a conflict
    // rather than letting store.update's throw fall into the generic 500.
    if (current.validUntil !== null) {
      throw new HttpError(409, "conflict", "superseded");
    }
    // Same rationale as handleSupersedeMemory below: catch the store's typed
    // collision error and map it to 409, without ever forwarding its
    // message (which may embed memory text) to the caller.
    let memory;
    try {
      memory = store.update(id, patch, CTX);
    } catch (err) {
      if (err instanceof LiveTextCollisionError) {
        throw new HttpError(409, "conflict", "duplicate_text");
      }
      if (isStrictRedactionRefusal(err)) {
        throw new HttpError(400, STRICT_REDACTION_REFUSAL_MESSAGE, "strict_redaction_refused");
      }
      throw err;
    }
    sendJson(res, 200, memory);
  }

  async function handleDeleteMemory(res: ServerResponse, id: string): Promise<void> {
    const deleted = store.forget(id, CTX);
    sendJson(res, 200, { deleted });
  }

  async function handleRestoreMemory(res: ServerResponse, id: string): Promise<void> {
    // Same rationale as handleSupersedeMemory below: catch the store's typed
    // collision error and map it to 409, without ever forwarding its
    // message (which may embed memory text) to the caller.
    let restored;
    try {
      restored = store.restore(id, CTX);
    } catch (err) {
      if (err instanceof LiveTextCollisionError) {
        throw new HttpError(409, "conflict", "duplicate_text");
      }
      throw err;
    }
    sendJson(res, 200, { restored });
  }

  async function handleSupersedeMemory(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const body = asRecord(await readBody(req));
    const text = body["text"];
    if (typeof text !== "string") {
      throw new HttpError(400, "text is required");
    }
    const tags = Array.isArray(body["tags"]) ? clampTags(body["tags"]) : undefined;
    const importance = validateImportance(body["importance"]);
    if (!store.get(id, { includeDeleted: true, includeSuperseded: true }, CTX)) {
      throw new HttpError(404, "not found");
    }
    // No pre-check is possible here without duplicating the store's own
    // live-hash lookup (Store exposes no "does this text collide" query) --
    // catch the store's typed collision error instead and map it to 409,
    // without ever forwarding the store's message (which may embed memory
    // text) to the caller.
    let result;
    try {
      result = store.supersede(id, { text, tags, importance }, CTX);
    } catch (err) {
      if (err instanceof LiveTextCollisionError) {
        throw new HttpError(409, "conflict", "duplicate_text");
      }
      if (isStrictRedactionRefusal(err)) {
        throw new HttpError(400, STRICT_REDACTION_REFUSAL_MESSAGE, "strict_redaction_refused");
      }
      throw err;
    }
    sendJson(res, 200, { superseded: result.superseded, replacement: result.replacement });
  }

  // The only human-facing way to flip `approved` (BUILD_BRIEF §9/§10): a
  // 'user'-origin memory is already eligible for session-start injection
  // without this, so approving one is a no-op, not an error -- the route
  // does not special-case it, since store.setMemoryApproved is happy to set
  // the flag on any memory and context.ts's gate only ever consults
  // `origin === 'user' || approved`.
  async function handleApproveMemory(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const body = asRecord(await readBody(req));
    if (typeof body["approved"] !== "boolean") {
      throw new HttpError(400, "approved must be a boolean");
    }
    if (!store.get(id, { includeDeleted: true, includeSuperseded: true }, CTX)) {
      throw new HttpError(404, "not found");
    }
    let memory;
    try {
      memory = store.setMemoryApproved(id, body["approved"], CTX);
    } catch (err) {
      if (isReadOnlyRefusal(err)) {
        throw new HttpError(403, "forbidden", "read_only");
      }
      throw err;
    }
    sendJson(res, 200, memory);
  }

  async function handleBulk(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = asRecord(await readBody(req));
    const op = body["op"];
    if (op !== "forget" && op !== "restore" && op !== "approve" && op !== "unapprove") {
      throw new HttpError(400, `op must be "forget", "restore", "approve" or "unapprove"`);
    }
    const ids = body["ids"];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw new HttpError(400, "ids must be an array of strings");
    }
    if (ids.length > MAX_BULK_IDS) {
      throw new HttpError(400, `ids exceeds the cap of ${MAX_BULK_IDS}`);
    }
    // Contract: each id is applied one at a time through the same gated,
    // audited single-id store methods used by the non-bulk routes -- this
    // is NOT one atomic transaction across ids. A collision (or any other
    // failure) on one id must not undo or block the ids already committed,
    // so each id is caught individually and reported in its own result
    // rather than aborting -- or worse, having already partially committed
    // -- the whole request. A read-only store refuses every id identically,
    // so that one is not worth reporting per-id -- it short-circuits the
    // whole request with 403, same status as the single-id route above.
    const results = (ids as string[]).map((id) => {
      try {
        if (op === "forget" || op === "restore") {
          const ok = op === "forget" ? store.forget(id, CTX) : store.restore(id, CTX);
          return { id, ok };
        }
        if (!store.get(id, { includeDeleted: true, includeSuperseded: true }, CTX)) {
          return { id, ok: false, reason: "not_found" as const };
        }
        store.setMemoryApproved(id, op === "approve", CTX);
        return { id, ok: true };
      } catch (err) {
        if (err instanceof LiveTextCollisionError) {
          return { id, ok: false, reason: "conflict" as const };
        }
        if (isReadOnlyRefusal(err)) {
          throw new HttpError(403, "forbidden", "read_only");
        }
        throw err;
      }
    });
    sendJson(res, 200, { op, results, count: results.length });
  }

  // BUILD_BRIEF §8: instruction-only orchestration ("remember to call
  // recall") is only 60-70% reliable, so a session-start context injection
  // has to be deterministic -- driven by a client hook, not the model's
  // goodwill -- and this route is what that hook fetches over HTTP.
  // Store.context() already enforces the token budget itself; §8/§14 name
  // "context pollution" (a project that dumped its whole memory store into
  // context and had to retreat) as exactly the failure that budget exists
  // to prevent, so this handler must never offer a path around it.
  async function handleContext(res: ServerResponse, url: URL): Promise<void> {
    const q = parseStringParam(url, "q") ?? "";
    const scope = parseStringParam(url, "scope");
    const tokenBudget = parseRequiredIntParam(url, "budget");
    const block = await store.context(q, { scope, tokenBudget }, CTX);
    sendJson(res, 200, {
      text: block.text,
      memories: block.memories,
      tokensEstimated: block.tokensEstimated,
      truncated: block.truncated,
      degraded: block.degraded,
      degradedReason: toSafeDegradedReason(block.degraded),
    });
  }

  async function handleEpisodes(res: ServerResponse, url: URL): Promise<void> {
    const scope = parseStringParam(url, "scope");
    const limit = parseIntParam(url, "limit");
    const cursor = parseStringParam(url, "cursor") ?? null;
    const result = store.episodes({ scope, limit, cursor }, CTX);
    sendJson(res, 200, result);
  }

  async function handleEpisode(res: ServerResponse, id: string): Promise<void> {
    const episode = store.episode(id, CTX);
    if (!episode) {
      throw new HttpError(404, "not found");
    }
    sendJson(res, 200, episode);
  }

  async function handleTimeline(res: ServerResponse, url: URL): Promise<void> {
    const at = parseIntParam(url, "at");
    if (at === undefined) {
      throw new HttpError(400, "at is required and must be numeric");
    }
    const scope = parseStringParam(url, "scope");
    const limit = parseIntParam(url, "limit");
    const items = store.asOf(at, { scope, limit }, CTX);
    sendJson(res, 200, { items });
  }

  async function handleAudit(res: ServerResponse, url: URL): Promise<void> {
    const options: Parameters<Store["auditLog"]>[0] = {};
    const action = parseStringParam(url, "action");
    if (action !== undefined) options.action = action as Parameters<Store["auditLog"]>[0] extends { action?: infer A } ? A : never;
    const sourceClient = parseStringParam(url, "sourceClient");
    if (sourceClient !== undefined) options.sourceClient = sourceClient;
    const memoryId = parseStringParam(url, "memoryId");
    if (memoryId !== undefined) options.memoryId = memoryId;
    const since = parseIntParam(url, "since");
    if (since !== undefined) options.since = since;
    const until = parseIntParam(url, "until");
    if (until !== undefined) options.until = until;
    const limit = parseIntParam(url, "limit");
    if (limit !== undefined) options.limit = limit;
    const cursor = parseStringParam(url, "cursor");
    if (cursor !== undefined) options.cursor = cursor;
    const refused = parseBoolParam(url, "refused");
    if (refused !== undefined) options.refused = refused;
    sendJson(res, 200, store.auditLog(options));
  }

  async function handleClients(res: ServerResponse, url: URL): Promise<void> {
    const since = parseIntParam(url, "since");
    const limit = parseIntParam(url, "limit");
    sendJson(res, 200, { clients: store.clients(), stats: store.clientStats({ since, limit }) });
  }

  async function handlePatchClient(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const body = asRecord(await readBody(req));
    if (typeof body["enabled"] !== "boolean") {
      throw new HttpError(400, "enabled must be a boolean");
    }
    // §9/§13: the dashboard is the user's ONLY control surface over
    // per-client pausing. `store.gate()` refuses EVERY gated call from a
    // disabled client, with no bypass -- if this route let the dashboard
    // disable its own client id, the very next dashboard request (including
    // the one needed to re-enable it) would be refused, locking the user
    // out of their own store with no recovery short of hand-editing SQLite.
    // Re-enabling (`{enabled: true}`) is harmless and stays allowed below.
    if (id === DASHBOARD_CLIENT && body["enabled"] === false) {
      sendJson(res, 400, { error: "the dashboard cannot pause itself" });
      return;
    }
    if (!store.clients().some((c) => c.id === id)) {
      throw new HttpError(404, "not found");
    }
    const client = store.setClientEnabled(id, body["enabled"]);
    sendJson(res, 200, client);
  }

  async function handleGetPrivacy(res: ServerResponse): Promise<void> {
    sendJson(res, 200, store.privacy());
  }

  async function handlePutPrivacy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = asRecord(await readBody(req));
    const mode = body["mode"];
    if (typeof mode !== "string" || !(VALID_PRIVACY_MODES as readonly string[]).includes(mode)) {
      throw new HttpError(400, `mode must be one of: ${VALID_PRIVACY_MODES.join(", ")}`);
    }
    sendJson(res, 200, store.setPrivacy(mode as PrivacyMode, CTX));
  }

  async function handleRedactions(res: ServerResponse, url: URL): Promise<void> {
    const options: Parameters<Store["redactions"]>[0] = {};
    const action = parseStringParam(url, "action");
    if (action !== undefined) options.action = action as Parameters<Store["redactions"]>[0] extends { action?: infer A } ? A : never;
    const memoryId = parseStringParam(url, "memoryId");
    if (memoryId !== undefined) options.memoryId = memoryId;
    const since = parseIntParam(url, "since");
    if (since !== undefined) options.since = since;
    const limit = parseIntParam(url, "limit");
    if (limit !== undefined) options.limit = limit;
    const cursor = parseStringParam(url, "cursor");
    if (cursor !== undefined) options.cursor = cursor;
    sendJson(res, 200, store.redactions(options));
  }

  async function handleDeleteEverything(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = asRecord(await readBody(req));
    // Safety property, same as the store's own: anything other than the
    // literal `true` refuses, and nothing is deleted -- a stray truthy
    // value ("yes", 1) must not be treated as consent.
    if (body["confirm"] !== true) {
      sendJson(res, 400, { error: "confirm must be true" });
      return;
    }
    const result = store.deleteEverything({ confirm: true }, CTX);
    sendJson(res, 200, result);
  }

  // Read-only mirror of store.remember's own dedupe lookup (see
  // repositories/memories.ts's createMemory: `memories_live` keyed on
  // scope + content_hash), rebuilt from store.list() rather than a second
  // index -- there is no public Store method that answers "does this hash
  // already live in this scope" without also writing, and this module has
  // no business reaching past Store into raw SQL for one. Paged the same
  // way list_memories itself pages, and audited the same way (list_memories
  // reads), which is why a preview leaves list_memories audit rows behind
  // but never a remember/import one.
  function collectLiveContentHashes(scope: string): Set<string> {
    const hashes = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < IMPORT_PREVIEW_HASH_SCAN_PAGE_CAP; page++) {
      const { items, nextCursor } = store.list(
        { scope, includeDeleted: false, includeSuperseded: false, limit: MAX_PAGE_LIMIT, cursor },
        CTX,
      );
      for (const item of items) hashes.add(item.contentHash);
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    return hashes;
  }

  // Shared by handleImportPasted and handleImportChatGpt: runs each
  // candidate entry through the exact same redaction rule store.remember
  // applies (../privacy/redact.js's redactText, the same pure function, not
  // a reimplementation) and the same content-hash dedupe rule createMemory
  // applies, WITHOUT calling store.remember -- so nothing is written, no
  // episode is appended, and no redaction row is recorded (§10: a redaction
  // row is only ever recorded for a write that actually happened). A
  // duplicate within the pasted/found entries themselves (not just against
  // what is already live) is also caught, mirroring how a real confirmed
  // import's second occurrence would dedupe against the first entry's
  // just-created row.
  function buildImportPreview(texts: string[], scope: string | undefined): ImportPreview {
    const { mode } = store.privacy();
    const effectiveScope = scope ?? DEFAULT_SCOPE;
    const existingHashes = collectLiveContentHashes(effectiveScope);
    const pendingHashes = new Set<string>();

    let wouldImport = 0;
    let wouldSkipDuplicate = 0;
    let wouldRefuseStrict = 0;
    const entries: { text: string }[] = [];

    for (const raw of texts) {
      const redaction = redactText(raw, mode);
      if (mode === "strict" && redaction.blocked) {
        wouldRefuseStrict++;
        continue;
      }
      const hash = contentHash(redaction.text);
      if (existingHashes.has(hash) || pendingHashes.has(hash)) {
        wouldSkipDuplicate++;
        continue;
      }
      pendingHashes.add(hash);
      wouldImport++;
      if (entries.length < IMPORT_PREVIEW_ENTRY_LIMIT) {
        entries.push({ text: redaction.text });
      }
    }

    return {
      entries,
      entriesTruncated: wouldImport > entries.length,
      wouldImport,
      wouldSkipDuplicate,
      wouldRefuseStrict,
    };
  }

  // §1/§12's lock-in-escape hook, wired to the dashboard rather than a
  // ninth MCP tool (§2's ≤7 ceiling): a deliberate, user-initiated,
  // one-time paste. Writes through store.remember under IMPORT_CTX (not
  // plain CTX) so redaction, dedupe and the audit trail apply exactly as
  // they do for any other write, but this text is stamped origin: 'import'
  // rather than 'user' -- it came out of a file, not out of the user's own
  // typing, and must go through the same human-approval gate as any other
  // import before it can be auto-injected (see context.ts's
  // excludeUnapproved). These are new memories with no id of their own, so
  // minting fresh ones (not the id-preserving importMemory path) is
  // correct here.
  //
  // Without `confirm: true`, this PARSES and returns what would be created
  // without writing anything (see buildImportPreview above) -- the real
  // export formats have never been run against a genuine vendor export, so
  // an importer that writes immediately turns a wrong parse into silent
  // garbage in the store. Preview is the DEFAULT specifically because the
  // failure being mitigated is a caller who did not realise a write was
  // about to happen; `confirm: true` behaves exactly as this route always
  // has.
  async function handleImportPasted(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = asRecord(await readBody(req));
    const text = body["text"];
    if (typeof text !== "string") {
      throw new HttpError(400, "text is required");
    }
    const scope = typeof body["scope"] === "string" ? clampScope(body["scope"]) : undefined;
    const tags = Array.isArray(body["tags"]) ? clampTags(body["tags"]) : undefined;
    const confirm = body["confirm"] === true;

    const parsed = parsePastedMemories(text);

    if (!confirm) {
      const preview = buildImportPreview(
        parsed.map((entry) => entry.text),
        scope,
      );
      sendJson(res, 200, {
        preview: true,
        totalParsed: parsed.length,
        entries: preview.entries,
        entriesTruncated: preview.entriesTruncated,
        wouldImport: preview.wouldImport,
        wouldSkipDuplicate: preview.wouldSkipDuplicate,
        wouldRefuseStrict: preview.wouldRefuseStrict,
      });
      return;
    }

    let imported = 0;
    let skipped = 0;
    let refused = 0;
    // Each entry is its own store.remember call/transaction, so a strict-mode
    // refusal on one entry must not abort the rest -- caught and counted
    // per entry, exactly like handleBulk's per-id handling above. Anything
    // that is NOT that specific refusal is a genuine bug and still propagates
    // to the generic 500 handler rather than being swallowed here.
    for (const entry of parsed) {
      try {
        const result = store.remember({ content: entry.text, scope, tags }, IMPORT_CTX);
        if (result.deduped) {
          skipped++;
        } else {
          imported++;
        }
      } catch (err) {
        if (isStrictRedactionRefusal(err)) {
          refused++;
          continue;
        }
        throw err;
      }
    }
    if (imported > 0) {
      bus?.publish({ type: "list_changed", sourceSessionId: DASHBOARD_CLIENT });
    }
    sendJson(res, 200, { imported, skipped, refused });
  }

  // Same rationale as handleImportPasted above, for the one officially-
  // confirmed structured field in a ChatGPT export (§16 milestone 10):
  // custom instructions. A parse failure is a client mistake (not a
  // ChatGPT export), answered with ImporterFormatError's own message --
  // which by construction never echoes the input -- so no further
  // scrubbing is needed here, unlike the no-echo rule elsewhere in this
  // file that guards against exactly that.
  //
  // Same preview-then-confirm shape as handleImportPasted above, and for
  // the same reason: `conversations.json`'s shape is unverified against a
  // real export (see importers/chatgpt.ts), so preview is the default here
  // too.
  async function handleImportChatGpt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = asRecord(await readBody(req));
    const scope = typeof body["scope"] === "string" ? clampScope(body["scope"]) : undefined;
    const confirm = body["confirm"] === true;

    let instructions;
    try {
      instructions = extractCustomInstructions(body["conversations"]);
    } catch (err) {
      if (err instanceof ImporterFormatError) {
        throw new HttpError(400, err.message);
      }
      throw err;
    }

    const fields: { value: string | undefined; tag: string }[] = [
      { value: instructions.aboutUser, tag: "chatgpt-about-user" },
      { value: instructions.aboutModel, tag: "chatgpt-about-model" },
    ];
    const found = fields.filter((f) => f.value !== undefined && f.value.length > 0).length;

    if (!confirm) {
      const preview = buildImportPreview(
        fields.filter((f) => f.value !== undefined && f.value.length > 0).map((f) => f.value as string),
        scope,
      );
      sendJson(res, 200, {
        preview: true,
        found,
        entries: preview.entries,
        entriesTruncated: preview.entriesTruncated,
        wouldImport: preview.wouldImport,
        wouldSkipDuplicate: preview.wouldSkipDuplicate,
        wouldRefuseStrict: preview.wouldRefuseStrict,
      });
      return;
    }

    let imported = 0;
    let skipped = 0;
    let refused = 0;
    // Each field is its own store.remember call/transaction, so a strict-mode
    // refusal on one field must not abort the rest -- caught and counted per
    // field, exactly like handleImportPasted's per-entry handling above.
    // Anything that is NOT that specific refusal is a genuine bug and still
    // propagates to the generic 500 handler rather than being swallowed here.
    for (const field of fields) {
      if (field.value === undefined || field.value.length === 0) continue;
      try {
        const result = store.remember(
          { content: field.value, scope, tags: ["chatgpt-import", field.tag] },
          IMPORT_CTX,
        );
        if (result.deduped) {
          skipped++;
        } else {
          imported++;
        }
      } catch (err) {
        if (isStrictRedactionRefusal(err)) {
          refused++;
          continue;
        }
        throw err;
      }
    }
    if (imported > 0) {
      bus?.publish({ type: "list_changed", sourceSessionId: DASHBOARD_CLIENT });
    }
    sendJson(res, 200, { imported, skipped, refused, found });
  }

  function handleEvents(req: IncomingMessage, res: ServerResponse): void {
    if (sseStreams.size >= MAX_SSE_STREAMS) {
      sendJson(res, 503, { error: "too many active event streams; try again later" });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
    });
    // Node otherwise queues headers until the first body write, so a
    // client would see no response at all until this stream's first event
    // (or the heartbeat, up to SSE_HEARTBEAT_INTERVAL_MS later) -- flush
    // now so the client learns the connection succeeded immediately.
    res.flushHeaders();

    // Set once `stream` exists below -- the subscribe callback needs it to
    // drop this stream, but it must be wired up before `stream` can be
    // constructed (which itself needs `unsubscribe`).
    let stream: SseStream | undefined;

    const unsubscribe = bus
      ? bus.subscribe((event: MemoryEvent) => {
          const ok = res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          // Dropping a stream the client is not draining is correct: an SSE
          // client reconnects on its own, whereas continuing to queue for
          // it is an unbounded memory cost paid by every other user of the
          // daemon (a suspended tab or a sleeping laptop never comes back
          // to drain it). `res.write` returning false means Node's own
          // buffer is already full; only act once it has also grown past a
          // sane cap, so an ordinary momentary stall does not drop a
          // perfectly healthy stream.
          if (!ok && res.writableLength > SSE_BACKPRESSURE_CAP_BYTES && stream) {
            endStream(stream);
          }
        })
      : () => {};

    // unref()'d so a heartbeat on an otherwise-idle stream never keeps the
    // process alive by itself -- same pattern as server.ts's session sweep
    // and embeddings/worker.ts's own interval.
    const heartbeat = setInterval(() => {
      const ok = res.write(":\n\n");
      if (!ok && res.writableLength > SSE_BACKPRESSURE_CAP_BYTES && stream) {
        endStream(stream);
      }
    }, SSE_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    stream = { res, unsubscribe, heartbeat };
    sseStreams.add(stream);

    // `res.on("close")`, not `req.on("close")`: an IncomingMessage's own
    // "close" fires once its (empty, for a GET) body has been fully read --
    // essentially immediately -- and does NOT mean the client disconnected.
    // The ServerResponse's "close" is the one that means the underlying
    // connection actually ended, which is what must trigger the unsubscribe.
    res.on("close", () => {
      endStream(stream);
    });
  }

  // The route table: [method, path pattern] -> handler. A trailing ":id"
  // (and ":id/verb") segment is matched positionally rather than with a
  // regex per route, since every path here is short and fixed-shape.
  async function route(req: IncomingMessage, res: ServerResponse, url: URL, segments: string[]): Promise<void> {
    const method = req.method ?? "GET";

    // /api/stats
    if (segments.length === 1 && segments[0] === "stats") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      await handleStats(res, url);
      return;
    }

    // /api/events
    if (segments.length === 1 && segments[0] === "events") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      handleEvents(req, res);
      return;
    }

    // /api/context
    if (segments.length === 1 && segments[0] === "context") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      await handleContext(res, url);
      return;
    }

    // /api/memories, /api/memories/:id, /api/memories/:id/restore, /api/memories/:id/supersede,
    // /api/memories/:id/approve, /api/memories/bulk
    if (segments[0] === "memories") {
      if (segments.length === 1) {
        if (method !== "GET") throw new HttpError(405, "method not allowed");
        await handleListMemories(res, url);
        return;
      }
      if (segments.length === 2 && segments[1] === "bulk") {
        if (method !== "POST") throw new HttpError(405, "method not allowed");
        await handleBulk(req, res);
        return;
      }
      if (segments.length === 2) {
        const id = requireId(segments, 1);
        if (method === "GET") {
          await handleGetMemory(res, url, id);
          return;
        }
        if (method === "PATCH") {
          await handlePatchMemory(req, res, id);
          return;
        }
        if (method === "DELETE") {
          await handleDeleteMemory(res, id);
          return;
        }
        throw new HttpError(405, "method not allowed");
      }
      if (segments.length === 3 && segments[2] === "restore") {
        if (method !== "POST") throw new HttpError(405, "method not allowed");
        await handleRestoreMemory(res, requireId(segments, 1));
        return;
      }
      if (segments.length === 3 && segments[2] === "supersede") {
        if (method !== "POST") throw new HttpError(405, "method not allowed");
        await handleSupersedeMemory(req, res, requireId(segments, 1));
        return;
      }
      if (segments.length === 3 && segments[2] === "approve") {
        if (method !== "POST") throw new HttpError(405, "method not allowed");
        await handleApproveMemory(req, res, requireId(segments, 1));
        return;
      }
      throw new HttpError(404, "not found");
    }

    // /api/episodes, /api/episodes/:id
    if (segments[0] === "episodes") {
      if (segments.length === 1) {
        if (method !== "GET") throw new HttpError(405, "method not allowed");
        await handleEpisodes(res, url);
        return;
      }
      if (segments.length === 2) {
        if (method !== "GET") throw new HttpError(405, "method not allowed");
        await handleEpisode(res, requireId(segments, 1));
        return;
      }
      throw new HttpError(404, "not found");
    }

    // /api/timeline
    if (segments.length === 1 && segments[0] === "timeline") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      await handleTimeline(res, url);
      return;
    }

    // /api/audit
    if (segments.length === 1 && segments[0] === "audit") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      await handleAudit(res, url);
      return;
    }

    // /api/clients, /api/clients/:id
    if (segments[0] === "clients") {
      if (segments.length === 1) {
        if (method !== "GET") throw new HttpError(405, "method not allowed");
        await handleClients(res, url);
        return;
      }
      if (segments.length === 2) {
        if (method !== "PATCH") throw new HttpError(405, "method not allowed");
        await handlePatchClient(req, res, requireId(segments, 1));
        return;
      }
      throw new HttpError(404, "not found");
    }

    // /api/privacy, /api/privacy/delete-everything
    if (segments[0] === "privacy") {
      if (segments.length === 1) {
        if (method === "GET") {
          await handleGetPrivacy(res);
          return;
        }
        if (method === "PUT") {
          await handlePutPrivacy(req, res);
          return;
        }
        throw new HttpError(405, "method not allowed");
      }
      if (segments.length === 2 && segments[1] === "delete-everything") {
        if (method !== "POST") throw new HttpError(405, "method not allowed");
        await handleDeleteEverything(req, res);
        return;
      }
      throw new HttpError(404, "not found");
    }

    // /api/redactions
    if (segments.length === 1 && segments[0] === "redactions") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      await handleRedactions(res, url);
      return;
    }

    // /api/import/pasted, /api/import/chatgpt
    if (segments[0] === "import") {
      if (segments.length === 2 && segments[1] === "pasted") {
        if (method !== "POST") throw new HttpError(405, "method not allowed");
        await handleImportPasted(req, res);
        return;
      }
      if (segments.length === 2 && segments[1] === "chatgpt") {
        if (method !== "POST") throw new HttpError(405, "method not allowed");
        await handleImportChatGpt(req, res);
        return;
      }
      throw new HttpError(404, "not found");
    }

    throw new HttpError(404, "not found");
  }

  return {
    async handle(req, res, url) {
      const pathname = url.pathname;
      if (pathname !== "/api" && !pathname.startsWith("/api/")) {
        return false;
      }

      // Never emit CORS headers, and never answer an OPTIONS preflight:
      // requiring `Authorization` is what stops a random web page the user
      // has open from driving this API cross-origin (setting that header
      // cross-origin forces a preflight, which this module never answers).
      // The daemon also rejects a present-and-foreign `Origin` before this
      // module ever sees the request (src/daemon/server.ts, checked before
      // routing) -- but that check lives entirely in server.ts, not here,
      // so this module makes no such guarantee on its own. The bearer
      // check below is therefore load-bearing by itself, not redundant
      // with server.ts's check, for any caller of createDashboardApi that
      // does not sit behind that same Origin check.
      if (!authorize(req)) {
        sendJson(res, 401, { error: "unauthorized" });
        return true;
      }

      // Decode AFTER splitting, not before: a %2F inside an id must survive
      // as part of that one segment rather than becoming a path separator.
      // Client ids are free text taken from an MCP client's own
      // clientInfo.name (e.g. "Visual Studio Code"), and memory/episode ids
      // are opaque, so every segment -- not just the ones this route table
      // happens to treat as an id -- must be decoded the same way.
      let segments: string[];
      try {
        segments = pathname
          .slice("/api".length)
          .split("/")
          .filter((s) => s.length > 0)
          .map((s) => decodeURIComponent(s));
      } catch (err) {
        if (err instanceof URIError) {
          sendJson(res, 400, { error: "malformed path" });
          return true;
        }
        throw err;
      }

      try {
        await route(req, res, url, segments);
      } catch (err) {
        if (res.headersSent) {
          // The handler already started writing a response (e.g. SSE) --
          // nothing more can be sent.
          return true;
        }
        if (err instanceof HttpError) {
          sendJson(res, err.status, err.reason ? { error: err.message, reason: err.reason } : { error: err.message });
          return true;
        }
        if (isMalformedCursorError(err)) {
          sendJson(res, 400, { error: "malformed cursor" });
          return true;
        }
        // Never log or echo the error -- it may embed a request body or
        // memory content (same rule as ../daemon/server.ts).
        sendJson(res, 500, { error: "internal error" });
      }
      return true;
    },

    close() {
      for (const stream of Array.from(sseStreams)) {
        endStream(stream);
      }
    },
  };
}
