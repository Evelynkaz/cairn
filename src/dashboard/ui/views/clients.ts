// The Connected apps view (BUILD_BRIEF §9): which MCP clients share this
// store, what they have read/written, and a per-client pause/resume control
// over GET/PATCH /api/clients.

import { el, clear, text } from "../dom.js";
import { getClients, patchClient, ApiError, DASHBOARD_CLIENT_ID } from "../api-client.js";
import type { ClientInfo, ClientsResult } from "../api-client.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

const DASHBOARD_SELF_PAUSE_TITLE = "The dashboard cannot pause itself -- doing so would lock you out of pausing or resuming anything else.";

// Joins the two arrays GET /api/clients returns on client id. They are not
// guaranteed the same length or order: a client with no reads/writes yet has
// no stats row, and (defensively) a stats row could in principle reference a
// client id no longer in the client list.
interface Row {
  id: string;
  name: string;
  firstSeen: number | null;
  lastSeen: number | null;
  enabled: boolean | null;
  reads: number;
  writes: number;
}

export function buildRows(result: ClientsResult): Row[] {
  const statsById = new Map<string, { reads: number; writes: number }>();
  for (const s of result.stats) {
    statsById.set(s.sourceClient, { reads: s.reads, writes: s.writes });
  }
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const c of result.clients) {
    seen.add(c.id);
    const stats = statsById.get(c.id);
    rows.push({
      id: c.id,
      name: c.name || c.id,
      firstSeen: c.firstSeen,
      lastSeen: c.lastSeen,
      enabled: c.enabled,
      reads: stats?.reads ?? 0,
      writes: stats?.writes ?? 0,
    });
  }
  for (const s of result.stats) {
    if (seen.has(s.sourceClient)) continue;
    rows.push({
      id: s.sourceClient,
      name: s.sourceClient,
      firstSeen: null,
      lastSeen: null,
      enabled: null,
      reads: s.reads,
      writes: s.writes,
    });
  }
  return rows;
}

function formatDate(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

export function formatRelative(ms: number | null, now: number): string {
  if (ms === null) return "—";
  const diff = now - ms;
  if (diff < MS_PER_MINUTE) return "just now";
  if (diff < MS_PER_HOUR) {
    const n = Math.floor(diff / MS_PER_MINUTE);
    return `${n} minute${n === 1 ? "" : "s"} ago`;
  }
  if (diff < MS_PER_DAY) {
    const n = Math.floor(diff / MS_PER_HOUR);
    return `${n} hour${n === 1 ? "" : "s"} ago`;
  }
  const n = Math.floor(diff / MS_PER_DAY);
  return `${n} day${n === 1 ? "" : "s"} ago`;
}

export function mountClientsView(container: HTMLElement): () => void {
  let rows: Row[] = [];
  let loading = true;
  let error: string | null = null;
  let destroyed = false;

  // ids currently mid-toggle: their control is disabled and shows the
  // optimistic state until the request settles one way or the other.
  const pending = new Set<string>();
  let toggleError: string | null = null;

  async function load(): Promise<void> {
    loading = true;
    error = null;
    render();
    try {
      const result = await getClients();
      if (destroyed) return;
      rows = buildRows(result);
    } catch (err) {
      if (destroyed) return;
      error = err instanceof ApiError ? err.message : "Could not reach the daemon.";
    } finally {
      loading = false;
      if (!destroyed) render();
    }
  }

  async function handleToggle(row: Row): Promise<void> {
    if (row.enabled === null) return;
    const desired = !row.enabled;
    const previous = row.enabled;
    row.enabled = desired;
    pending.add(row.id);
    toggleError = null;
    render();
    try {
      const updated = await patchClient(row.id, desired);
      if (destroyed) return;
      row.enabled = updated.enabled;
    } catch (err) {
      if (destroyed) return;
      row.enabled = previous;
      toggleError = err instanceof ApiError ? err.message : `Could not update ${row.name}.`;
    } finally {
      pending.delete(row.id);
      if (!destroyed) render();
    }
  }

  const tbodyEl = el("tbody", {}, []);
  const theadEl = el("thead", {}, [
    el("tr", {}, [
      el("th", { scope: "col" }, ["Client"]),
      el("th", { scope: "col" }, ["First seen"]),
      el("th", { scope: "col" }, ["Last seen"]),
      el("th", { scope: "col" }, ["Reads"]),
      el("th", { scope: "col" }, ["Writes"]),
      el("th", { scope: "col" }, ["Status"]),
    ]),
  ]);
  const tableEl = el("table", { class: "memories-table" }, [theadEl, tbodyEl]);
  const tableWrapperEl = el("div", { class: "table-scroll" }, [tableEl]);
  const stateSlot = el("div", {});
  const tableContainerEl = el("div", { class: "table-container" });
  const errorSlot = el("div", {});

  container.appendChild(el("div", { class: "memories-view" }, [errorSlot, tableContainerEl]));

  function setBodyMode(mode: "state" | "table"): void {
    if (mode === "state") {
      if (tableWrapperEl.parentNode) tableContainerEl.removeChild(tableWrapperEl);
      if (!stateSlot.parentNode) tableContainerEl.appendChild(stateSlot);
    } else {
      if (stateSlot.parentNode) tableContainerEl.removeChild(stateSlot);
      if (!tableWrapperEl.parentNode) tableContainerEl.appendChild(tableWrapperEl);
    }
  }

  function renderRow(row: Row): HTMLElement {
    const now = Date.now();
    const lastSeenCell = el("td", { class: "cell-timestamp" }, [
      row.lastSeen === null
        ? "—"
        : el("span", { title: formatDate(row.lastSeen) }, [formatRelative(row.lastSeen, now)]),
    ]);

    let statusCell: HTMLElement;
    if (row.enabled === null) {
      statusCell = el("td", { class: "cell-actions" }, [el("span", { class: "muted" }, ["—"])]);
    } else {
      const isDashboard = row.id === DASHBOARD_CLIENT_ID;
      const isPending = pending.has(row.id);
      const toggleBtn = el(
        "button",
        {
          type: "button",
          class: "btn btn-quiet btn-small",
          disabled: isDashboard || isPending || undefined,
          title: isDashboard ? DASHBOARD_SELF_PAUSE_TITLE : undefined,
        },
        [row.enabled ? "Pause" : "Resume"],
      ) as HTMLButtonElement;
      toggleBtn.disabled = isDashboard || isPending;
      if (!isDashboard) {
        toggleBtn.addEventListener("click", () => void handleToggle(row));
      }
      const children: (HTMLElement | Text)[] = [
        el("span", { class: row.enabled ? undefined : "muted" }, [row.enabled ? "Active" : "Paused"]),
        toggleBtn,
      ];
      if (isDashboard) {
        children.push(el("span", { class: "muted" }, [" This is the dashboard itself; it cannot pause itself."]));
      }
      statusCell = el("td", { class: "cell-actions" }, [el("div", { class: "cell-actions-inner" }, children)]);
    }

    return el("tr", {}, [
      el("td", {}, [row.name]),
      el("td", { class: "cell-timestamp" }, [formatDate(row.firstSeen)]),
      lastSeenCell,
      el("td", {}, [String(row.reads)]),
      el("td", {}, [String(row.writes)]),
      statusCell,
    ]);
  }

  function renderEmptyState(): HTMLElement {
    return el("div", { class: "empty-state" }, [
      el("p", {}, ["No clients yet."]),
      el("p", { class: "muted" }, [
        "Clients show up here once an MCP client (Claude, Cursor, ...) connects and calls a tool like ",
        el("code", {}, ["remember"]),
        " or ",
        el("code", {}, ["recall"]),
        ".",
      ]),
    ]);
  }

  function updateBody(): void {
    if (loading && rows.length === 0) {
      clear(stateSlot);
      stateSlot.appendChild(el("div", { class: "state-panel" }, [el("p", {}, ["Loading clients…"])]));
      setBodyMode("state");
    } else if (error) {
      clear(stateSlot);
      const retryBtn = el("button", { type: "button", class: "btn" }, ["Retry"]);
      retryBtn.addEventListener("click", () => void load());
      stateSlot.appendChild(el("div", { class: "state-panel state-error" }, [el("p", {}, [error]), retryBtn]));
      setBodyMode("state");
    } else if (rows.length === 0) {
      clear(stateSlot);
      stateSlot.appendChild(renderEmptyState());
      setBodyMode("state");
    } else {
      setBodyMode("table");
      clear(tbodyEl);
      for (const row of rows) tbodyEl.appendChild(renderRow(row));
    }
  }

  function render(): void {
    if (destroyed) return;
    clear(errorSlot);
    if (toggleError) {
      const dismissBtn = el("button", { type: "button", class: "toast-close", "aria-label": "Dismiss" }, ["×"]);
      dismissBtn.addEventListener("click", () => {
        toggleError = null;
        render();
      });
      errorSlot.appendChild(
        el("div", { class: "state-panel state-error" }, [el("p", {}, [toggleError]), dismissBtn]),
      );
    }
    updateBody();
  }

  render();
  void load();

  return () => {
    destroyed = true;
  };
}
