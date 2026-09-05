// Thin typed wrapper over fetch for the dashboard's /api/* routes. Every
// call goes through `request()` below, so the bearer header, the API's
// error shape ({"error": "..."}) and same-origin-only behavior are handled
// in exactly one place -- no call site can forget the header or leak a
// credential cross-origin.

import { getToken, clearToken } from "./state.js";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
    throw new ApiError(res.status, message);
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
}

export function getStats(): Promise<StatsResult> {
  return request<StatsResult>("GET", "/api/stats?topLimit=50");
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

export interface BulkResult {
  op: "forget" | "restore";
  results: Array<{ id: string; ok: boolean }>;
  count: number;
}

export function bulkOp(op: "forget" | "restore", ids: string[]): Promise<BulkResult> {
  return request<BulkResult>("POST", "/api/memories/bulk", { op, ids });
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
