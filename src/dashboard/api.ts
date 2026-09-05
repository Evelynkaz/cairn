// The whole `/api` namespace the dashboard SPA talks to (BUILD_BRIEF §9,
// §13). Deliberately its own module, not wired into the daemon here -- a
// later step does that (see src/daemon/server.ts). Reuses the HTTP
// primitives from ../daemon/http.js rather than re-implementing the body
// cap or the constant-time token comparison a second time.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../storage/index.js";
import { VALID_PRIVACY_MODES } from "../storage/index.js";
import type { PrivacyMode } from "../storage/index.js";
import type { MemoryEvent, MemoryEventBus } from "../mcp/events.js";
import { PayloadTooLargeError, readJsonBody, sendJson, tokenMatches } from "../daemon/http.js";
import { DASHBOARD_CLIENT } from "../config/identity.js";
import { LiveTextCollisionError } from "../storage/repositories/memories.js";
import { extractCustomInstructions, ImporterFormatError, parsePastedMemories } from "../portability/importers/index.js";

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

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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

// Shared by GET /api/context and GET /api/memories?q=... (search mode): both
// surface the retrieval layer's `degraded`/`degradedReason` (BUILD_BRIEF §7),
// but the raw `degradedReason` string set at src/retrieval/search.ts's catch
// block is `error instanceof Error ? error.message : String(error)` -- the
// unmodified text thrown by whatever embedding provider is configured
// (Ollama, OpenAI, Voyage, ..., all HTTP-backed per BUILD_BRIEF §3). That
// text originates outside our code and can carry a provider URL, a host
// name, a file path, or an upstream API's raw error body. The no-echo rule
// in ../daemon/server.ts -- an error's own text never reaches an HTTP caller
// -- applies to it exactly like any other error text, so it is dropped here
// and replaced with a fixed, safe value. `degraded` (the boolean) is left
// untouched; it is already safe and is what the UI needs.
type SafeDegradedReason = "embedding_failed" | null;
function toSafeDegradedReason(degraded: boolean): SafeDegradedReason {
  return degraded ? "embedding_failed" : null;
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
    if (Array.isArray(body["tags"])) patch.tags = body["tags"].map(String);
    if (body["importance"] !== undefined) patch.importance = validateImportance(body["importance"]);
    const current = store.get(id, { includeDeleted: true, includeSuperseded: true }, CTX);
    if (!current) {
      throw new HttpError(404, "not found");
    }
    // A superseded memory is history (§5): editing it is a request the
    // store's rules forbid, not a server fault -- answer it as a conflict
    // rather than letting store.update's throw fall into the generic 500.
    if (current.validUntil !== null) {
      throw new HttpError(409, "conflict");
    }
    // Same rationale as handleSupersedeMemory below: catch the store's typed
    // collision error and map it to 409, without ever forwarding its
    // message (which may embed memory text) to the caller.
    let memory;
    try {
      memory = store.update(id, patch, CTX);
    } catch (err) {
      if (err instanceof LiveTextCollisionError) {
        throw new HttpError(409, "conflict");
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
        throw new HttpError(409, "conflict");
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
    const tags = Array.isArray(body["tags"]) ? body["tags"].map(String) : undefined;
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
        throw new HttpError(409, "conflict");
      }
      throw err;
    }
    sendJson(res, 200, { superseded: result.superseded, replacement: result.replacement });
  }

  async function handleBulk(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = asRecord(await readBody(req));
    const op = body["op"];
    if (op !== "forget" && op !== "restore") {
      throw new HttpError(400, `op must be "forget" or "restore"`);
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
    // -- the whole request.
    const results = (ids as string[]).map((id) => {
      try {
        const ok = op === "forget" ? store.forget(id, CTX) : store.restore(id, CTX);
        return { id, ok };
      } catch (err) {
        if (err instanceof LiveTextCollisionError) {
          return { id, ok: false, reason: "conflict" as const };
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

  // §1/§12's lock-in-escape hook, wired to the dashboard rather than a
  // ninth MCP tool (§2's ≤7 ceiling): a deliberate, user-initiated,
  // one-time paste. Writes through store.remember under the dashboard's
  // own call context so redaction, dedupe and the audit trail apply
  // exactly as they do for any other write -- these are new memories with
  // no id of their own, so minting fresh ones (not the id-preserving
  // importMemory path) is correct here.
  async function handleImportPasted(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = asRecord(await readBody(req));
    const text = body["text"];
    if (typeof text !== "string") {
      throw new HttpError(400, "text is required");
    }
    const scope = typeof body["scope"] === "string" ? body["scope"] : undefined;
    const tags = Array.isArray(body["tags"]) ? body["tags"].map(String) : undefined;

    const parsed = parsePastedMemories(text);
    let imported = 0;
    let skipped = 0;
    for (const entry of parsed) {
      const result = store.remember({ content: entry.text, scope, tags }, CTX);
      if (result.deduped) {
        skipped++;
      } else {
        imported++;
      }
    }
    if (imported > 0) {
      bus?.publish({ type: "list_changed", sourceSessionId: DASHBOARD_CLIENT });
    }
    sendJson(res, 200, { imported, skipped });
  }

  // Same rationale as handleImportPasted above, for the one officially-
  // confirmed structured field in a ChatGPT export (§16 milestone 10):
  // custom instructions. A parse failure is a client mistake (not a
  // ChatGPT export), answered with ImporterFormatError's own message --
  // which by construction never echoes the input -- so no further
  // scrubbing is needed here, unlike the no-echo rule elsewhere in this
  // file that guards against exactly that.
  async function handleImportChatGpt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = asRecord(await readBody(req));
    const scope = typeof body["scope"] === "string" ? body["scope"] : undefined;

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

    let imported = 0;
    let skipped = 0;
    for (const field of fields) {
      if (field.value === undefined || field.value.length === 0) continue;
      const result = store.remember({ content: field.value, scope, tags: ["chatgpt-import", field.tag] }, CTX);
      if (result.deduped) {
        skipped++;
      } else {
        imported++;
      }
    }
    if (imported > 0) {
      bus?.publish({ type: "list_changed", sourceSessionId: DASHBOARD_CLIENT });
    }
    sendJson(res, 200, { imported, skipped, found });
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
      res.write(":\n\n");
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

    // /api/memories, /api/memories/:id, /api/memories/:id/restore, /api/memories/:id/supersede, /api/memories/bulk
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
          sendJson(res, err.status, { error: err.message });
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
