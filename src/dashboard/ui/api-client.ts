// Thin typed wrapper over fetch for the dashboard's /api/* routes. Every
// call goes through `request()` below, so the bearer header, the API's
// error shape ({"error": "..."}) and same-origin-only behavior are handled
// in exactly one place -- no call site can forget the header or leak a
// credential cross-origin.

import { getToken, clearToken } from "./state.js";

export class ApiError extends Error {
  readonly status: number;
  // Only ever set on a 409: a fixed enum ("superseded" | "duplicate_text",
  // see src/dashboard/api.ts's ConflictReason) telling apart the two
  // different meanings that status code carries there. Typed as `string`
  // here, not the literal union, since this module has no reason to import
  // that server-side type -- a caller narrows it with `===` itself.
  readonly reason?: string;
  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

// Set once by app.ts at startup. Called whenever any request comes back
// 401, so the whole app falls back to the "no token" screen from one
// place instead of every call site re-implementing that.
let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler;
}

// Any active subscribeToEvents() loop registers its permanent-stop function
// here. A 401 from an ordinary request (not the stream itself) means the
// token has gone bad daemon-side -- e.g. a restart minted a new one -- so
// the stream must stop reconnecting too, not just this one call.
const activeSseStops = new Set<() => void>();

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  // `path` is always a same-origin, root-relative "/api/..." string built by
  // this module -- never a caller-supplied absolute URL -- and credentials
  // stay at their fetch default of "same-origin" with no CORS header ever
  // set, so this can only ever talk to the daemon that served this page.
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    clearToken();
    unauthorizedHandler?.();
    for (const stop of activeSseStops) stop();
    throw new ApiError(401, "unauthorized");
  }
  const raw = await res.text();
  let data: unknown = null;
  if (raw.length > 0) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const message =
      data !== null && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `request failed with status ${res.status}`;
    const reason =
      data !== null && typeof data === "object" && typeof (data as { reason?: unknown }).reason === "string"
        ? (data as { reason: string }).reason
        : undefined;
    throw new ApiError(res.status, message, reason);
  }
  return data as T;
}

export interface Memory {
  id: string;
  seq: number;
  text: string;
  scope: string;
  sourceClient: string | null;
  importance: number;
  createdAt: number;
  updatedAt: number;
  lastAccessed: number | null;
  accessCount: number;
  validFrom: number;
  validUntil: number | null;
  supersededBy: string | null;
  episodeId: string | null;
  deletedAt: number | null;
  redacted: boolean;
  contentHash: string;
  tags: string[];
  origin: "user" | "import" | "unknown";
  // Whether this memory is eligible for SessionStart auto-injection despite
  // not being 'user'-origin -- see /api/memories/:id/approve below.
  approved: boolean;
}

export interface SearchHit {
  id: string;
  seq: number;
  text: string;
  scope: string;
  tags: string[];
  importance: number;
  createdAt: number;
  lastAccessed: number | null;
  accessCount: number;
  score: number;
  origin?: "user" | "import" | "unknown";
  approved?: boolean;
}

export type ListMemoriesResult =
  | { mode: "list"; items: Memory[]; nextCursor: string | null }
  | { mode: "search"; hits: SearchHit[]; degraded: boolean; degradedReason: string | null };

export interface ListMemoriesParams {
  q?: string;
  scope?: string;
  tags?: string[];
  sourceClient?: string;
  // Filters on createdAt: `since` is inclusive, `until` is exclusive --
  // i.e. `[since, until)` -- matching src/storage/repositories/memories.ts's
  // listMemories, so callers converting a date-only UI value must add a day
  // to `until` rather than treat both ends the same way.
  since?: number;
  until?: number;
  limit?: number;
  cursor?: string | null;
  includeDeleted?: boolean;
  includeSuperseded?: boolean;
}

export interface StatsResult {
  liveMemories: number;
  deletedMemories: number;
  supersededMemories: number;
  episodes: number;
  redactedMemories: number;
  scopes: Array<{ scope: string; count: number }>;
  topTags: Array<{ tag: string; count: number }>;
  oldestCreatedAt: number | null;
  newestCreatedAt: number | null;
  recentActivity: number;
  vectors: boolean;
  journalMode: string | null;
  redactions: Array<{ kind: string; action: string; count: number }>;
}

export function getStats(): Promise<StatsResult> {
  return request<StatsResult>("GET", "/api/stats?topLimit=50");
}

export interface GetContextParams {
  q?: string;
  scope?: string;
  budget?: number;
}

export interface ContextResult {
  text: string;
  memories: SearchHit[];
  tokensEstimated: number;
  truncated: boolean;
  degraded: boolean;
  degradedReason: string | null;
}

export function getContext(params: GetContextParams = {}): Promise<ContextResult> {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.scope) sp.set("scope", params.scope);
  if (params.budget !== undefined) sp.set("budget", String(params.budget));
  const qs = sp.toString();
  return request<ContextResult>("GET", `/api/context${qs ? `?${qs}` : ""}`);
}

export function listMemories(params: ListMemoriesParams): Promise<ListMemoriesResult> {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.scope) sp.set("scope", params.scope);
  if (params.tags && params.tags.length > 0) sp.set("tags", params.tags.join(","));
  if (params.sourceClient) sp.set("sourceClient", params.sourceClient);
  if (params.since !== undefined) sp.set("since", String(params.since));
  if (params.until !== undefined) sp.set("until", String(params.until));
  if (params.limit !== undefined) sp.set("limit", String(params.limit));
  if (params.cursor) sp.set("cursor", params.cursor);
  if (params.includeDeleted) sp.set("includeDeleted", "1");
  if (params.includeSuperseded) sp.set("includeSuperseded", "1");
  const qs = sp.toString();
  return request<ListMemoriesResult>("GET", `/api/memories${qs ? `?${qs}` : ""}`);
}

export function patchMemory(
  id: string,
  patch: { text?: string; tags?: string[]; importance?: number },
): Promise<Memory> {
  return request<Memory>("PATCH", `/api/memories/${encodeURIComponent(id)}`, patch);
}

export function deleteMemory(id: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>("DELETE", `/api/memories/${encodeURIComponent(id)}`);
}

export function restoreMemory(id: string): Promise<{ restored: boolean }> {
  return request<{ restored: boolean }>("POST", `/api/memories/${encodeURIComponent(id)}/restore`);
}

export interface GetMemoryOptions {
  includeDeleted?: boolean;
  includeSuperseded?: boolean;
}

export function getMemory(id: string, opts: GetMemoryOptions = {}): Promise<Memory> {
  const sp = new URLSearchParams();
  if (opts.includeDeleted) sp.set("includeDeleted", "1");
  if (opts.includeSuperseded) sp.set("includeSuperseded", "1");
  const qs = sp.toString();
  return request<Memory>("GET", `/api/memories/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`);
}

export interface SupersedeResult {
  superseded: Memory;
  replacement: Memory;
}

// The server answers 409 when `body.text` collides with an existing live
// memory (and deliberately never echoes memory text in that error) -- the
// caller must catch ApiError and check `.status === 409` itself to show a
// useful message, since `.message` carries nothing text-specific to show.
export function supersedeMemory(
  id: string,
  body: { text: string; tags?: string[]; importance?: number },
): Promise<SupersedeResult> {
  return request<SupersedeResult>("POST", `/api/memories/${encodeURIComponent(id)}/supersede`, body);
}

export interface BulkResult {
  op: "forget" | "restore" | "approve" | "unapprove";
  results: Array<{ id: string; ok: boolean; reason?: "conflict" | "not_found" }>;
  count: number;
}

export function bulkOp(op: "forget" | "restore" | "approve" | "unapprove", ids: string[]): Promise<BulkResult> {
  return request<BulkResult>("POST", "/api/memories/bulk", { op, ids });
}

// The only human-facing way to make an 'import'/'unknown'-origin memory
// eligible for SessionStart auto-injection (see src/retrieval/context.ts's
// excludeUnapproved) -- never set as a side effect of any other write.
export function approveMemory(id: string, approved: boolean): Promise<Memory> {
  return request<Memory>("POST", `/api/memories/${encodeURIComponent(id)}/approve`, { approved });
}

export interface ClientInfo {
  id: string;
  name: string;
  firstSeen: number;
  lastSeen: number;
  enabled: boolean;
}

export interface ClientsResult {
  clients: ClientInfo[];
  stats: Array<{ sourceClient: string; reads: number; writes: number }>;
}

// Powers the source-client filter's <select> (BUILD_BRIEF §9): the
// dashboard needs the full list of clients that have ever touched the
// store, not just the ones with memories on the current page.
export function getClients(): Promise<ClientsResult> {
  return request<ClientsResult>("GET", "/api/clients");
}

// Mirrors src/config/identity.ts's DASHBOARD_CLIENT. Not imported directly:
// this module is compiled by tsconfig.ui.json with rootDir set to
// src/dashboard/ui, which rejects any import reaching outside that
// directory (TS6059) -- so the value is kept in sync here by hand instead.
export const DASHBOARD_CLIENT_ID = "cairn-dashboard";

export function patchClient(id: string, enabled: boolean): Promise<ClientInfo> {
  return request<ClientInfo>("PATCH", `/api/clients/${encodeURIComponent(id)}`, { enabled });
}

export function getTimeline(params: { at: number; scope?: string; limit?: number }): Promise<{ items: Memory[] }> {
  const sp = new URLSearchParams();
  sp.set("at", String(params.at));
  if (params.scope) sp.set("scope", params.scope);
  if (params.limit !== undefined) sp.set("limit", String(params.limit));
  return request<{ items: Memory[] }>("GET", `/api/timeline?${sp.toString()}`);
}

export interface AuditEntry {
  id: number;
  ts: number;
  action: string;
  memoryId: string | null;
  scope: string | null;
  sourceClient: string | null;
  query: string | null;
  resultCount: number | null;
  details: Record<string, unknown> | null;
  refused: boolean;
}

export interface AuditResult {
  items: AuditEntry[];
  nextCursor: string | null;
}

export interface GetAuditParams {
  action?: string;
  sourceClient?: string;
  memoryId?: string;
  since?: number;
  until?: number;
  limit?: number;
  cursor?: string;
  refused?: boolean;
}

export function getAudit(params: GetAuditParams = {}): Promise<AuditResult> {
  const sp = new URLSearchParams();
  if (params.action) sp.set("action", params.action);
  if (params.sourceClient) sp.set("sourceClient", params.sourceClient);
  if (params.memoryId) sp.set("memoryId", params.memoryId);
  if (params.since !== undefined) sp.set("since", String(params.since));
  if (params.until !== undefined) sp.set("until", String(params.until));
  if (params.limit !== undefined) sp.set("limit", String(params.limit));
  if (params.cursor) sp.set("cursor", params.cursor);
  if (params.refused !== undefined) sp.set("refused", String(params.refused));
  const qs = sp.toString();
  return request<AuditResult>("GET", `/api/audit${qs ? `?${qs}` : ""}`);
}

// `preview` is already a MASKED excerpt by the time it reaches the daemon
// (BUILD_BRIEF §10) -- e.g. "AKIA...MPLE" -- never the raw secret. There is
// no unmasked value anywhere to show; do not try to add one here.
export interface RedactionEntry {
  id: number;
  ts: number;
  memoryId: string | null;
  episodeId: string | null;
  scope: string | null;
  sourceClient: string | null;
  kind: string;
  preview: string;
  action: string;
}

export interface RedactionsResult {
  items: RedactionEntry[];
  nextCursor: string | null;
}

export interface GetRedactionsParams {
  action?: string;
  memoryId?: string;
  since?: number;
  limit?: number;
  cursor?: string;
}

export function getRedactions(params: GetRedactionsParams = {}): Promise<RedactionsResult> {
  const sp = new URLSearchParams();
  if (params.action) sp.set("action", params.action);
  if (params.memoryId) sp.set("memoryId", params.memoryId);
  if (params.since !== undefined) sp.set("since", String(params.since));
  if (params.limit !== undefined) sp.set("limit", String(params.limit));
  if (params.cursor) sp.set("cursor", params.cursor);
  const qs = sp.toString();
  return request<RedactionsResult>("GET", `/api/redactions${qs ? `?${qs}` : ""}`);
}

export interface Episode {
  id: string;
  content: string;
  scope: string;
  sourceClient: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface EpisodesResult {
  items: Episode[];
  nextCursor: string | null;
}

export function getEpisodes(params: { scope?: string; limit?: number; cursor?: string } = {}): Promise<EpisodesResult> {
  const sp = new URLSearchParams();
  if (params.scope) sp.set("scope", params.scope);
  if (params.limit !== undefined) sp.set("limit", String(params.limit));
  if (params.cursor) sp.set("cursor", params.cursor);
  const qs = sp.toString();
  return request<EpisodesResult>("GET", `/api/episodes${qs ? `?${qs}` : ""}`);
}

export function getEpisode(id: string): Promise<Episode> {
  return request<Episode>("GET", `/api/episodes/${encodeURIComponent(id)}`);
}

export type PrivacyMode = "off" | "on" | "strict";

export interface PrivacyState {
  mode: PrivacyMode;
  source: string;
}

export function getPrivacy(): Promise<PrivacyState> {
  return request<PrivacyState>("GET", "/api/privacy");
}

export function putPrivacy(mode: PrivacyMode): Promise<PrivacyState> {
  return request<PrivacyState>("PUT", "/api/privacy", { mode });
}

export interface DeleteEverythingResult {
  memories: number;
  episodes: number;
  vectors: number;
}

// `confirm: true` is hardcoded rather than a parameter: the server refuses
// with 400 unless it is the literal `true`, so exposing it as an argument
// would only let a caller pass the wrong thing.
export function deleteEverything(): Promise<DeleteEverythingResult> {
  return request<DeleteEverythingResult>("POST", "/api/privacy/delete-everything", { confirm: true });
}

// The two importers behind the dashboard's "Import" panel (BUILD_BRIEF
// §1/§12): neither ChatGPT's nor Claude's data export contains a memory
// file, so a user copies their stored memory text out of the product's own
// settings screen and pastes it here, or uploads a ChatGPT
// conversations.json export for its one officially-confirmed structured
// field (custom instructions). Both write through store.remember, so
// `skipped` below always means "deduped", never an error.
export interface ImportResult {
  imported: number;
  skipped: number;
}

// `refused` counts entries the store's strict privacy mode blocked outright
// (a detected secret) -- distinct from `skipped`, which always means
// "deduped", never an error. Each entry is its own store.remember call, so
// one refused line never aborts the rest of the paste.
export interface PastedImportResult extends ImportResult {
  refused: number;
}

export function importPasted(body: { text: string; scope?: string; tags?: string[] }): Promise<PastedImportResult> {
  return request<PastedImportResult>("POST", "/api/import/pasted", body);
}

// `refused` mirrors PastedImportResult's above: the store's strict privacy
// mode blocked that field outright (a detected secret), distinct from
// `skipped` ("deduped"). Each field is its own store.remember call, so one
// refused field never aborts the other.
export interface ImportChatGptResult extends ImportResult {
  refused: number;
  // How many of the two known custom-instruction fields (about-user,
  // about-model) the export actually contained -- lets the panel say
  // "found 1 of 2 fields" even when both ended up deduped, not just
  // "imported 0".
  found: number;
}

// `conversations` is the parsed JSON array from a ChatGPT
// conversations.json export -- unknown here because
// extractCustomInstructions (src/portability/importers/chatgpt.ts) does its
// own loose shape check server-side and answers 400 with a descriptive
// message rather than this client pre-validating it.
export function importChatGpt(body: { conversations: unknown; scope?: string }): Promise<ImportChatGptResult> {
  return request<ImportChatGptResult>("POST", "/api/import/chatgpt", body);
}

// The event bus payload (src/mcp/events.ts): only ever "updated" or
// "list_changed" plus provenance fields the dashboard does not need --
// every event here is a cue to refresh, not content to render, so callers
// only need `type`.
export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

// Exported so the exact byte stream the daemon produces (including CRLF
// heartbeats and awkward chunk splits) can be fed through this directly in
// a test, rather than only being exercisable via a live connection.
export function parseSseEvent(raw: string): StreamEvent | null {
  // Per the SSE spec, multiple "data:" lines in one frame are concatenated
  // with "\n"; a line starting with ":" is a comment (the daemon's
  // heartbeat) and is ignored rather than treated as data.
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  const dataLine = dataLines.join("\n");
  if (dataLine.length === 0) return null;
  try {
    return JSON.parse(dataLine) as StreamEvent;
  } catch {
    return null;
  }
}

// Buffers raw decoded chunks and yields complete SSE frames. Per the SSE
// spec a producer may legitimately terminate lines with CRLF instead of LF;
// our own daemon (src/dashboard/api.ts) always writes LF ("\n\n"), but
// normalizing CRLF to LF up front means a single "\n\n" split handles a
// CRLF-framed source too, a frame split across a chunk boundary (partial
// frames stay in the buffer until the next push), and a heartbeat
// immediately followed by a real event in the same chunk.
export function createSseFrameParser(): { push: (chunk: string) => StreamEvent[] } {
  let buffer = "";
  return {
    push(chunk: string): StreamEvent[] {
      buffer += chunk.replace(/\r\n/g, "\n");
      const events: StreamEvent[] = [];
      let sepIndex = buffer.indexOf("\n\n");
      while (sepIndex >= 0) {
        const rawEvent = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        const event = parseSseEvent(rawEvent);
        if (event) events.push(event);
        sepIndex = buffer.indexOf("\n\n");
      }
      return events;
    },
  };
}

// EventSource cannot set an Authorization header, and /api/events requires
// the same bearer check as every other route -- so this reads the SSE wire
// format itself over a plain authenticated fetch(), which can send the
// header. Returns an unsubscribe function; call it on page unload so the
// underlying connection (and any pending reconnect timer) does not outlive
// the page.
export function subscribeToEvents(onEvent: (event: StreamEvent) => void): () => void {
  let stopped = false;
  // A 401 (ours or any other request's) means the token is permanently
  // invalid for this page load -- unlike a network hiccup, backing off and
  // retrying will only produce one 401 per attempt forever, so this latches
  // the loop closed instead of scheduling another attempt.
  let unauthorized = false;
  let controller: AbortController | null = null;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function stopPermanently(): void {
    if (unauthorized) return;
    unauthorized = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    controller?.abort();
  }

  async function connect(): Promise<void> {
    if (stopped || unauthorized) return;
    const token = getToken();
    if (!token) return; // no point retrying without a token; app.ts owns re-auth
    controller = new AbortController();
    try {
      const res = await fetch("/api/events", {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (res.status === 401) {
        unauthorized = true;
        clearToken();
        unauthorizedHandler?.();
        return;
      }
      if (!res.ok || !res.body) {
        throw new Error(`event stream failed with status ${res.status}`);
      }
      attempt = 0; // reset backoff once a stream is actually established
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const frameParser = createSseFrameParser();
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const event of frameParser.push(decoder.decode(value, { stream: true }))) {
          onEvent(event);
        }
      }
    } catch (err) {
      // fetch's own abort (this function's cleanup, or a permanent
      // unauthorized stop) throws a DOMException named "AbortError" -- that
      // is not a connection failure to retry.
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
    if (!stopped && !unauthorized) scheduleReconnect();
  }

  function scheduleReconnect(): void {
    attempt += 1;
    const delayMs = Math.min(1000 * 2 ** attempt, 30_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
  }

  activeSseStops.add(stopPermanently);
  connect();

  return () => {
    stopped = true;
    activeSseStops.delete(stopPermanently);
    controller?.abort();
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  };
}
