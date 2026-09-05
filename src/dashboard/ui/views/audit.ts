// The Access log view (BUILD_BRIEF §2's "privacy is a feature"): a readable
// table over GET /api/audit -- who read or wrote what, and when. Structure
// mirrors memories.ts: mounting, loading/error/empty states, ApiError
// handling, markup via el/clear/text, cursor pagination, cleanup on unmount.

import { el, clear, text } from "../dom.js";
import { getAudit, getClients, ApiError } from "../api-client.js";
import type { AuditEntry, ClientInfo } from "../api-client.js";

const PAGE_SIZE = 50;

// The full AuditAction union from src/storage/repositories/audit.ts, read
// directly off the server source rather than guessed. "privacy_mode" and
// "client_enabled" are control-surface changes, not memory traffic, but
// they still land in audit_log and are valid things to filter this raw log
// by, so they are included here too.
const AUDIT_ACTIONS = [
  "remember",
  "recall",
  "get_context",
  "list_memories",
  "update_memory",
  "forget",
  "restore",
  "export",
  "import",
  "privacy_mode",
  "client_enabled",
] as const;

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

// Date inputs hand back a bare "YYYY-MM-DD" with no timezone attached --
// interpreted here as a calendar day in the browser's own local timezone,
// matching memories.ts's startOfLocalDay.
export function startOfLocalDay(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime();
}

// Unlike memories.ts's `created_at < ?` (exclusive), the audit query filters
// with `ts <= ?` (inclusive) -- see src/storage/repositories/audit.ts. So
// the upper bound must land on the last millisecond of the selected day, not
// the first millisecond of the next one, or a row stamped at local midnight
// rolling into the next day gets included here too.
//
// The next local midnight is derived from the calendar (`d + 1`), not by
// adding a constant 24h -- a DST transition day is not always 86,400,000ms
// long, and adding a constant would silently drop or duplicate an hour on
// the day the clocks change.
export function untilBound(dateStr: string): number | null {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) return null;
  const ms = new Date(y, m - 1, d + 1).getTime() - 1;
  return Number.isFinite(ms) ? ms : null;
}

export function formatDetails(details: Record<string, unknown> | null): string {
  if (details === null) return "—";
  const keys = Object.keys(details);
  if (keys.length === 0) return "—";
  return JSON.stringify(details);
}

export function mountAuditView(container: HTMLElement): () => void {
  // --- filter state --------------------------------------------------------
  let action = "";
  let sourceClient = "";
  let refused = "";
  let sinceDate = "";
  let untilDate = "";

  let cursor: string | undefined;
  let cursorHistory: (string | undefined)[] = [];
  let nextCursor: string | null = null;

  let entries: AuditEntry[] = [];
  let loading = true;
  let error: string | null = null;

  let clientsForFilters: ClientInfo[] | null = null;

  const expanded = new Set<number>();
  let destroyed = false;
  // Guards against a stale response landing after a fresher request: only
  // the response matching the most recently issued requestId is applied.
  let requestId = 0;

  // --- data loading ----------------------------------------------------------

  async function loadClientOptions(): Promise<void> {
    try {
      const result = await getClients();
      if (destroyed) return;
      clientsForFilters = result.clients;
    } catch {
      if (destroyed) return;
      clientsForFilters = null;
    }
    updateSourceClientOptions();
  }

  function filtersActive(): boolean {
    return action !== "" || sourceClient !== "" || refused !== "" || sinceDate !== "" || untilDate !== "";
  }

  async function load(): Promise<void> {
    const myRequestId = ++requestId;
    loading = true;
    error = null;
    render();
    try {
      const result = await getAudit({
        action: action || undefined,
        sourceClient: sourceClient || undefined,
        refused: refused === "" ? undefined : refused === "true",
        since: sinceDate ? startOfLocalDay(sinceDate) : undefined,
        until: untilDate ? (untilBound(untilDate) ?? undefined) : undefined,
        limit: PAGE_SIZE,
        cursor,
      });
      if (destroyed || myRequestId !== requestId) return;
      entries = result.items;
      nextCursor = result.nextCursor;
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

  function resetPagingAndLoad(): void {
    cursor = undefined;
    cursorHistory = [];
    void load();
  }

  // --- toolbar (built once) ---------------------------------------------------

  const actionSelect = el("select", { class: "audit-action-select", "aria-label": "Filter by action" }, [
    el("option", { value: "" }, ["All actions"]),
    ...AUDIT_ACTIONS.map((a) => el("option", { value: a }, [a])),
  ]) as HTMLSelectElement;
  actionSelect.addEventListener("change", () => {
    action = actionSelect.value;
    resetPagingAndLoad();
  });

  const sourceClientSelect = el("select", { class: "source-client-select", "aria-label": "Filter by source client" }, [
    el("option", { value: "" }, ["All clients"]),
  ]) as HTMLSelectElement;
  sourceClientSelect.addEventListener("change", () => {
    sourceClient = sourceClientSelect.value;
    resetPagingAndLoad();
  });

  const refusedSelect = el("select", { class: "audit-refused-select", "aria-label": "Filter by refused" }, [
    el("option", { value: "" }, ["All results"]),
    el("option", { value: "true" }, ["Refused only"]),
    el("option", { value: "false" }, ["Allowed only"]),
  ]) as HTMLSelectElement;
  refusedSelect.addEventListener("change", () => {
    refused = refusedSelect.value;
    resetPagingAndLoad();
  });

  const sinceInput = el("input", {
    type: "date",
    class: "since-input",
    "aria-label": "On or after this date",
  }) as HTMLInputElement;
  sinceInput.addEventListener("change", () => {
    sinceDate = sinceInput.value;
    resetPagingAndLoad();
  });

  const untilInput = el("input", {
    type: "date",
    class: "until-input",
    "aria-label": "On or before this date",
  }) as HTMLInputElement;
  untilInput.addEventListener("change", () => {
    untilDate = untilInput.value;
    resetPagingAndLoad();
  });

  const dateRange = el("span", { class: "date-range" }, [
    el("label", { class: "field-inline-label" }, ["From", sinceInput]),
    el("label", { class: "field-inline-label" }, ["To", untilInput]),
  ]);

  const toolbarEl = el("div", { class: "toolbar" }, [
    actionSelect,
    sourceClientSelect,
    refusedSelect,
    dateRange,
  ]);

  function updateSourceClientOptions(): void {
    clear(sourceClientSelect);
    sourceClientSelect.appendChild(el("option", { value: "" }, ["All clients"]));
    for (const c of clientsForFilters ?? []) {
      sourceClientSelect.appendChild(el("option", { value: c.id }, [c.name || c.id]));
    }
    sourceClientSelect.value = sourceClient;
  }

  // --- persistent table structure ---------------------------------------------

  const theadEl = el("thead", {}, [
    el("tr", {}, [
      el("th", { scope: "col" }, ["Time"]),
      el("th", { scope: "col" }, ["Action"]),
      el("th", { scope: "col" }, ["Source"]),
      el("th", { scope: "col" }, ["Scope"]),
      el("th", { scope: "col" }, ["Results"]),
      el("th", { scope: "col" }, ["Result"]),
      el("th", { scope: "col" }, ["Details"]),
    ]),
  ]);
  const tbodyEl = el("tbody", {}, []);
  const tableEl = el("table", { class: "memories-table" }, [theadEl, tbodyEl]);
  const tableWrapperEl = el("div", { class: "table-scroll" }, [tableEl]);
  const pagerSlot = el("div", {});
  const tableSectionEl = el("div", {}, [tableWrapperEl, pagerSlot]);
  const stateSlot = el("div", {});
  const tableContainerEl = el("div", { class: "table-container" });

  container.appendChild(el("div", { class: "memories-view" }, [toolbarEl, tableContainerEl]));

  // --- rendering ---------------------------------------------------------------

  function renderDetailsCell(entryEl: AuditEntry): HTMLElement {
    const hasDetails = entryEl.details !== null && Object.keys(entryEl.details).length > 0;
    const hasQuery = entryEl.query !== null;
    if (!hasDetails && !hasQuery) return el("td", {}, [text("—")]);
    const isExpanded = expanded.has(entryEl.id);
    const summaryParts: string[] = [];
    if (hasQuery) summaryParts.push(`query: ${entryEl.query}`);
    if (hasDetails) summaryParts.push(formatDetails(entryEl.details));
    const summary = summaryParts.join(" · ");
    const toggle = el(
      "button",
      { type: "button", class: `text-toggle ${isExpanded ? "expanded" : "truncated"}`, title: summary },
      [summary],
    );
    toggle.addEventListener("click", () => {
      if (isExpanded) expanded.delete(entryEl.id);
      else expanded.add(entryEl.id);
      render();
    });
    return el("td", { class: "cell-text" }, [toggle]);
  }

  function renderRow(entryEl: AuditEntry): HTMLElement {
    return el("tr", {}, [
      el("td", { class: "cell-timestamp" }, [formatDate(entryEl.ts)]),
      el("td", {}, [entryEl.action]),
      el("td", {}, [entryEl.sourceClient ?? "—"]),
      el("td", {}, [entryEl.scope ?? "—"]),
      el("td", {}, [entryEl.resultCount === null ? "—" : String(entryEl.resultCount)]),
      el("td", {}, [
        entryEl.refused
          ? el("span", { class: "badge badge-deleted" }, ["Refused"])
          : text("Allowed"),
      ]),
      renderDetailsCell(entryEl),
    ]);
  }

  function updateTbody(): void {
    clear(tbodyEl);
    for (const e of entries) tbodyEl.appendChild(renderRow(e));
  }

  function renderPager(): HTMLElement {
    const prevBtn = el("button", { type: "button", class: "btn btn-quiet" }, ["Previous"]) as HTMLButtonElement;
    prevBtn.disabled = loading || cursorHistory.length === 0;
    prevBtn.addEventListener("click", () => {
      const prev = cursorHistory.pop();
      cursor = prev;
      void load();
    });
    const nextBtn = el("button", { type: "button", class: "btn btn-quiet" }, ["Next"]) as HTMLButtonElement;
    nextBtn.disabled = loading || nextCursor === null;
    nextBtn.addEventListener("click", () => {
      cursorHistory.push(cursor);
      cursor = nextCursor ?? undefined;
      void load();
    });
    return el("div", { class: "pager" }, [prevBtn, nextBtn]);
  }

  function renderEmptyState(): HTMLElement {
    if (filtersActive()) {
      return el("div", { class: "empty-state" }, [
        el("p", {}, ["No access log entries match your filters."]),
        el("p", { class: "muted" }, ["Try clearing a filter."]),
      ]);
    }
    return el("div", { class: "empty-state" }, [
      el("p", {}, ["No access log entries yet."]),
      el("p", { class: "muted" }, [
        "Every read or write a connected MCP client makes against your memory gets logged here.",
      ]),
    ]);
  }

  function setBodyMode(mode: "state" | "table"): void {
    if (mode === "state") {
      if (tableSectionEl.parentNode) tableContainerEl.removeChild(tableSectionEl);
      if (!stateSlot.parentNode) tableContainerEl.appendChild(stateSlot);
    } else {
      if (stateSlot.parentNode) tableContainerEl.removeChild(stateSlot);
      if (!tableSectionEl.parentNode) tableContainerEl.appendChild(tableSectionEl);
    }
  }

  function updateBody(): void {
    if (loading && entries.length === 0) {
      clear(stateSlot);
      stateSlot.appendChild(el("div", { class: "state-panel" }, [el("p", {}, ["Loading access log…"])]));
      setBodyMode("state");
    } else if (error) {
      clear(stateSlot);
      const retryBtn = el("button", { type: "button", class: "btn" }, ["Retry"]);
      retryBtn.addEventListener("click", () => void load());
      stateSlot.appendChild(el("div", { class: "state-panel state-error" }, [el("p", {}, [error]), retryBtn]));
      setBodyMode("state");
    } else if (entries.length === 0) {
      clear(stateSlot);
      stateSlot.appendChild(renderEmptyState());
      setBodyMode("state");
    } else {
      setBodyMode("table");
      updateTbody();
      clear(pagerSlot);
      pagerSlot.appendChild(renderPager());
    }
  }

  function render(): void {
    if (destroyed) return;
    updateBody();
  }

  updateSourceClientOptions();
  render();
  void loadClientOptions();
  void load();

  return () => {
    destroyed = true;
  };
}
