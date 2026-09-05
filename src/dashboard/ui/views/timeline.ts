// The Timeline view: makes the temporal supersede-not-delete model visible
// (BUILD_BRIEF §7) by asking GET /api/timeline "what did the store look
// like at this instant" for a chosen point in time.

import { el, clear } from "../dom.js";
import { getTimeline, getStats, ApiError } from "../api-client.js";
import type { Memory } from "../api-client.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

// `<input type="datetime-local">` hands back / expects "YYYY-MM-DDTHH:mm" in
// the browser's own local timezone, with no timezone marker attached -- so
// converting to/from an epoch ms must go through the local Date
// constructor/getters, never Date.parse's UTC-leaning ISO handling.
export function epochToLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localInputValueToEpoch(value: string): number | null {
  if (!value) return null;
  const [datePart, timePart] = value.split("T");
  if (!datePart || !timePart) return null;
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
  if (y === undefined || m === undefined || d === undefined || hh === undefined || mm === undefined) return null;
  const ms = new Date(y, m - 1, d, hh, mm).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function mountTimelineView(container: HTMLElement): () => void {
  let at = Date.now();
  let scope = "";
  let limit: number = DEFAULT_LIMIT;

  let items: Memory[] = [];
  let loading = true;
  let error: string | null = null;

  let destroyed = false;
  // Guards against a stale response landing after a fresher request: only
  // the response matching the most recently issued requestId is applied.
  let requestId = 0;

  async function load(): Promise<void> {
    const myRequestId = ++requestId;
    loading = true;
    error = null;
    render();
    try {
      const result = await getTimeline({ at, scope: scope || undefined, limit });
      if (destroyed || myRequestId !== requestId) return;
      items = result.items;
    } catch (err) {
      if (destroyed || myRequestId !== requestId) return;
      error = err instanceof ApiError ? err.message : "Could not reach the daemon.";
    } finally {
      if (!destroyed && myRequestId === requestId) {
        loading = false;
        render();
      }
    }
  }

  async function loadScopeOptions(): Promise<void> {
    try {
      const stats = await getStats();
      if (destroyed) return;
      clear(scopeSelect);
      scopeSelect.appendChild(el("option", { value: "" }, ["All scopes"]));
      for (const s of stats.scopes) {
        scopeSelect.appendChild(el("option", { value: s.scope }, [`${s.scope} (${s.count})`]));
      }
      scopeSelect.value = scope;
    } catch {
      // Scope filter just falls back to "All scopes"; the timeline itself
      // still works without this.
    }
  }

  // --- controls (built once) -------------------------------------------------

  const atInput = el("input", {
    type: "datetime-local",
    class: "at-input",
    "aria-label": "Point in time",
    value: epochToLocalInputValue(at),
  }) as HTMLInputElement;
  atInput.addEventListener("change", () => {
    const ms = localInputValueToEpoch(atInput.value);
    if (ms === null) return;
    at = ms;
    void load();
  });

  function setAt(ms: number): void {
    at = ms;
    atInput.value = epochToLocalInputValue(at);
    void load();
  }

  function presetButton(label: string, offsetMs: number): HTMLElement {
    const btn = el("button", { type: "button", class: "btn btn-quiet btn-small" }, [label]);
    btn.addEventListener("click", () => setAt(Date.now() - offsetMs));
    return btn;
  }

  const presetsEl = el("div", { class: "toolbar" }, [
    presetButton("Now", 0),
    presetButton("1 hour ago", MS_PER_HOUR),
    presetButton("24 hours ago", MS_PER_DAY),
    presetButton("7 days ago", 7 * MS_PER_DAY),
    presetButton("30 days ago", 30 * MS_PER_DAY),
  ]);

  const scopeSelect = el("select", { class: "scope-select", "aria-label": "Filter by scope" }, [
    el("option", { value: "" }, ["All scopes"]),
  ]) as HTMLSelectElement;
  scopeSelect.addEventListener("change", () => {
    scope = scopeSelect.value;
    void load();
  });

  const limitInput = el("input", {
    type: "number",
    class: "limit-input",
    "aria-label": "Result limit",
    min: "1",
    max: String(MAX_LIMIT),
    value: String(limit),
  }) as HTMLInputElement;
  limitInput.addEventListener("change", () => {
    const n = Number(limitInput.value);
    if (!Number.isFinite(n) || n < 1) {
      limitInput.value = String(limit);
      return;
    }
    limit = Math.min(Math.trunc(n), MAX_LIMIT);
    limitInput.value = String(limit);
    void load();
  });

  const toolbarEl = el("div", { class: "toolbar" }, [
    el("label", { class: "field-inline-label" }, ["As of", atInput]),
    scopeSelect,
    el("label", { class: "field-inline-label" }, ["Limit", limitInput]),
  ]);

  const explanationEl = el("p", { class: "muted" }, [
    "\"As of\" shows the store's state at that instant, including memories that were later contradicted -- Cairn supersedes facts rather than deleting them, so the old one still appears here. Memories you have since forgotten are never shown, at any instant -- use the Memories view's \"include deleted\" to see those.",
  ]);

  // --- table structure (built once) -------------------------------------------

  const theadEl = el("thead", {}, [
    el("tr", {}, [
      el("th", { scope: "col" }, ["Text"]),
      el("th", { scope: "col" }, ["Scope"]),
      el("th", { scope: "col" }, ["Tags"]),
      el("th", { scope: "col" }, ["Created"]),
    ]),
  ]);
  const tbodyEl = el("tbody", {}, []);
  const tableEl = el("table", { class: "memories-table" }, [theadEl, tbodyEl]);
  const tableWrapperEl = el("div", { class: "table-scroll" }, [tableEl]);
  const stateSlot = el("div", {});
  const tableContainerEl = el("div", { class: "table-container" });

  container.appendChild(
    el("div", { class: "memories-view" }, [presetsEl, toolbarEl, explanationEl, tableContainerEl]),
  );

  function renderRow(m: Memory): HTMLElement {
    return el("tr", {}, [
      el("td", { class: "cell-text" }, [m.text]),
      el("td", {}, [m.scope]),
      el("td", { class: "cell-tags" }, [m.tags.join(", ") || "—"]),
      el("td", { class: "cell-timestamp" }, [formatDate(m.createdAt)]),
    ]);
  }

  function renderEmptyState(): HTMLElement {
    return el("div", { class: "empty-state" }, [
      el("p", {}, ["No live memories were stored at that point in time."]),
      el("p", { class: "muted" }, ["Try picking an earlier time, or clear the scope filter."]),
    ]);
  }

  function setBodyMode(mode: "state" | "table"): void {
    if (mode === "state") {
      if (tableWrapperEl.parentNode) tableContainerEl.removeChild(tableWrapperEl);
      if (!stateSlot.parentNode) tableContainerEl.appendChild(stateSlot);
    } else {
      if (stateSlot.parentNode) tableContainerEl.removeChild(stateSlot);
      if (!tableWrapperEl.parentNode) tableContainerEl.appendChild(tableWrapperEl);
    }
  }

  function render(): void {
    if (destroyed) return;
    if (loading && items.length === 0) {
      clear(stateSlot);
      stateSlot.appendChild(el("div", { class: "state-panel" }, [el("p", {}, ["Loading timeline…"])]));
      setBodyMode("state");
    } else if (error) {
      clear(stateSlot);
      const retryBtn = el("button", { type: "button", class: "btn" }, ["Retry"]);
      retryBtn.addEventListener("click", () => void load());
      stateSlot.appendChild(el("div", { class: "state-panel state-error" }, [el("p", {}, [error]), retryBtn]));
      setBodyMode("state");
    } else if (items.length === 0) {
      clear(stateSlot);
      stateSlot.appendChild(renderEmptyState());
      setBodyMode("state");
    } else {
      setBodyMode("table");
      clear(tbodyEl);
      for (const m of items) tbodyEl.appendChild(renderRow(m));
    }
  }

  render();
  void loadScopeOptions();
  void load();

  return () => {
    destroyed = true;
  };
}
