// The Memories view: BUILD_BRIEF §9's hero screenshot. A dense, editable,
// paginated table over GET /api/memories, with bulk forget/restore + undo,
// inline edit, and unobtrusive live refresh via the SSE stream.

import { el, clear, text } from "../dom.js";
import {
  listMemories,
  getStats,
  patchMemory,
  deleteMemory,
  restoreMemory,
  bulkOp,
  subscribeToEvents,
  ApiError,
} from "../api-client.js";
import type { Memory, SearchHit, StatsResult } from "../api-client.js";

const PAGE_SIZES = [25, 50, 100] as const;
const SEARCH_DEBOUNCE_MS = 300;
const TOAST_DURATION_MS = 8000;
// Mirrors MAX_LIMIT in src/retrieval/search.ts -- search results are
// hard-capped there regardless of the requested page size, so a result set
// at this size must say so rather than silently look complete.
const SEARCH_RESULT_CAP = 50;

// A normalized shape both list-mode Memory rows and search-mode SearchHit
// rows render through, so the table body has one code path instead of two.
// Fields a mode does not carry (e.g. a search hit's sourceClient) are null,
// never guessed.
interface Row {
  id: string;
  text: string;
  scope: string;
  tags: string[];
  importance: number;
  createdAt: number;
  updatedAt: number | null;
  sourceClient: string | null;
  deletedAt: number | null;
  validUntil: number | null;
  score: number | null;
}

function memoryToRow(m: Memory): Row {
  return {
    id: m.id,
    text: m.text,
    scope: m.scope,
    tags: m.tags,
    importance: m.importance,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    sourceClient: m.sourceClient,
    deletedAt: m.deletedAt,
    validUntil: m.validUntil,
    score: null,
  };
}

function hitToRow(h: SearchHit): Row {
  return {
    id: h.id,
    text: h.text,
    scope: h.scope,
    tags: h.tags,
    importance: h.importance,
    createdAt: h.createdAt,
    updatedAt: null,
    sourceClient: null,
    deletedAt: null,
    validUntil: null,
    score: h.score,
  };
}

function formatDate(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}

interface Toast {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function mountMemoriesView(container: HTMLElement): () => void {
  // --- filter / paging state -------------------------------------------------
  let q = "";
  let scope = "";
  let selectedTags = new Set<string>();
  let includeDeleted = false;
  let includeSuperseded = false;
  let pageSize: number = PAGE_SIZES[0];

  let cursor: string | null = null;
  let cursorHistory: (string | null)[] = [];
  let nextCursor: string | null = null;
  let mode: "list" | "search" = "list";

  let rows: Row[] = [];
  let degraded = false;
  let degradedReason: string | null = null;

  let loading = true;
  let error: string | null = null;

  let statsForFilters: StatsResult | null = null;

  const selected = new Set<string>();
  const expanded = new Set<string>();
  let editingId: string | null = null;
  let editDraft: { text: string; tags: string; importance: string } | null = null;
  let editError: string | null = null;

  let toast: Toast | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  // --- data loading ------------------------------------------------------

  async function loadFilterOptions(): Promise<void> {
    try {
      statsForFilters = await getStats();
    } catch {
      // Filters just fall back to free-text-less pickers; the table itself
      // still works without this.
      statsForFilters = null;
    }
    render();
  }

  function filtersActive(): boolean {
    return q.trim() !== "" || scope !== "" || selectedTags.size > 0 || includeDeleted || includeSuperseded;
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    render();
    try {
      const result = await listMemories({
        q: q.trim() || undefined,
        scope: scope || undefined,
        tags: selectedTags.size > 0 ? [...selectedTags] : undefined,
        limit: pageSize,
        cursor,
        includeDeleted,
        includeSuperseded,
      });
      if (destroyed) return;
      mode = result.mode;
      if (result.mode === "list") {
        rows = result.items.map(memoryToRow);
        nextCursor = result.nextCursor;
        degraded = false;
        degradedReason = null;
      } else {
        rows = result.hits.map(hitToRow);
        nextCursor = null;
        degraded = result.degraded;
        degradedReason = result.degradedReason;
      }
      // Selection only ever refers to rows currently on screen.
      for (const id of [...selected]) {
        if (!rows.some((r) => r.id === id)) selected.delete(id);
      }
    } catch (err) {
      if (destroyed) return;
      error = err instanceof ApiError ? err.message : "Could not reach the daemon.";
    } finally {
      loading = false;
      if (!destroyed) render();
    }
  }

  function resetPagingAndLoad(): void {
    cursor = null;
    cursorHistory = [];
    void load();
  }

  // --- actions -------------------------------------------------------------

  function showToast(t: Toast): void {
    if (toastTimer) clearTimeout(toastTimer);
    toast = t;
    render();
    toastTimer = setTimeout(() => {
      toast = null;
      render();
    }, TOAST_DURATION_MS);
  }

  async function handleDelete(id: string): Promise<void> {
    try {
      await deleteMemory(id);
      selected.delete(id);
      await load();
      showToast({
        message: "Memory forgotten.",
        actionLabel: "Undo",
        onAction: () => {
          void restoreMemory(id)
            .then(() => load())
            .catch((err) => {
              error = err instanceof ApiError ? err.message : "Could not undo that forget.";
              render();
            });
        },
      });
    } catch (err) {
      error = err instanceof ApiError ? err.message : "Could not delete that memory.";
      render();
    }
  }

  async function handleRestore(id: string): Promise<void> {
    try {
      await restoreMemory(id);
      await load();
    } catch (err) {
      error = err instanceof ApiError ? err.message : "Could not restore that memory.";
      render();
    }
  }

  async function handleBulkForget(): Promise<void> {
    const ids = [...selected];
    if (ids.length === 0) return;
    try {
      const result = await bulkOp("forget", ids);
      // The API returns { op, count, results: [{ id, ok }] }, not an
      // `ids` field -- undo must only restore the ones that actually
      // succeeded, not every id that was selected.
      const okIds = result.results.filter((r) => r.ok).map((r) => r.id);
      selected.clear();
      await load();
      showToast({
        message: `Forgot ${okIds.length} ${okIds.length === 1 ? "memory" : "memories"}.`,
        actionLabel: "Undo",
        onAction: () => {
          void bulkOp("restore", okIds)
            .then(() => load())
            .catch((err) => {
              error = err instanceof ApiError ? err.message : "Could not undo that bulk forget.";
              render();
            });
        },
      });
    } catch (err) {
      error = err instanceof ApiError ? err.message : "Bulk forget failed.";
      render();
    }
  }

  async function handleBulkRestore(): Promise<void> {
    const ids = [...selected];
    if (ids.length === 0) return;
    try {
      await bulkOp("restore", ids);
      selected.clear();
      await load();
    } catch (err) {
      error = err instanceof ApiError ? err.message : "Bulk restore failed.";
      render();
    }
  }

  function startEdit(row: Row): void {
    editingId = row.id;
    editError = null;
    editDraft = {
      text: row.text,
      tags: row.tags.join(", "),
      importance: String(row.importance),
    };
    render();
  }

  function cancelEdit(): void {
    editingId = null;
    editDraft = null;
    editError = null;
    render();
  }

  async function saveEdit(id: string): Promise<void> {
    if (!editDraft) return;
    const importanceNum = Number(editDraft.importance);
    if (!Number.isFinite(importanceNum) || importanceNum < 0 || importanceNum > 1) {
      editError = "Importance must be a number between 0 and 1.";
      render();
      return;
    }
    const tags = editDraft.tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    try {
      await patchMemory(id, { text: editDraft.text, tags, importance: importanceNum });
      editingId = null;
      editDraft = null;
      editError = null;
      await load();
    } catch (err) {
      editError =
        err instanceof ApiError
          ? err.status === 409
            ? "This memory has been superseded and can no longer be edited."
            : err.message
          : "Could not save that edit.";
      render();
    }
  }

  // --- live updates ----------------------------------------------------------

  const unsubscribeEvents = subscribeToEvents(() => {
    // Never clobber a field the user is actively editing: skip the
    // background refresh entirely while an inline edit is open, rather
    // than reconciling a partial merge. The next SSE event (or the user's
    // own save/cancel) resumes normal refreshing.
    if (editingId !== null) return;
    void load();
  });

  // --- rendering ---------------------------------------------------------

  function renderToolbar(): HTMLElement {
    const searchInput = el("input", {
      type: "search",
      class: "search-input",
      placeholder: "Search memories…",
      "aria-label": "Search memories",
      value: q,
    }) as HTMLInputElement;
    searchInput.addEventListener("input", () => {
      q = searchInput.value;
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => resetPagingAndLoad(), SEARCH_DEBOUNCE_MS);
    });

    const scopeOptions = [
      el("option", { value: "" }, ["All scopes"]),
      ...(statsForFilters?.scopes ?? []).map((s) =>
        el("option", { value: s.scope, selected: s.scope === scope || undefined }, [`${s.scope} (${s.count})`]),
      ),
    ];
    const scopeSelect = el("select", { class: "scope-select", "aria-label": "Filter by scope" }, scopeOptions) as HTMLSelectElement;
    scopeSelect.value = scope;
    scopeSelect.addEventListener("change", () => {
      scope = scopeSelect.value;
      resetPagingAndLoad();
    });

    const tagFieldset = el(
      "fieldset",
      { class: "tag-fieldset" },
      [
        el("legend", {}, ["Tags"]),
        ...(statsForFilters?.topTags ?? []).map((t) => {
          const checkbox = el("input", {
            type: "checkbox",
            id: `tag-${t.tag}`,
            checked: selectedTags.has(t.tag) || undefined,
          }) as HTMLInputElement;
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) selectedTags.add(t.tag);
            else selectedTags.delete(t.tag);
            resetPagingAndLoad();
          });
          return el("label", { class: "tag-option", for: `tag-${t.tag}` }, [checkbox, ` ${t.tag} (${t.count})`]);
        }),
      ],
    );
    const tagsDetails = el("details", { class: "tags-picker" }, [
      el("summary", {}, [selectedTags.size > 0 ? `Tags (${selectedTags.size})` : "Tags"]),
      tagFieldset,
    ]);

    const includeDeletedCheckbox = el("input", {
      type: "checkbox",
      id: "include-deleted",
      checked: includeDeleted || undefined,
    }) as HTMLInputElement;
    includeDeletedCheckbox.addEventListener("change", () => {
      includeDeleted = includeDeletedCheckbox.checked;
      resetPagingAndLoad();
    });

    const includeSupersededCheckbox = el("input", {
      type: "checkbox",
      id: "include-superseded",
      checked: includeSuperseded || undefined,
    }) as HTMLInputElement;
    includeSupersededCheckbox.addEventListener("change", () => {
      includeSuperseded = includeSupersededCheckbox.checked;
      resetPagingAndLoad();
    });

    const pageSizeSelect = el(
      "select",
      { class: "page-size-select", "aria-label": "Rows per page" },
      PAGE_SIZES.map((size) => el("option", { value: String(size), selected: size === pageSize || undefined }, [`${size} / page`])),
    ) as HTMLSelectElement;
    pageSizeSelect.value = String(pageSize);
    pageSizeSelect.addEventListener("change", () => {
      pageSize = Number(pageSizeSelect.value);
      resetPagingAndLoad();
    });

    return el("div", { class: "toolbar" }, [
      searchInput,
      scopeSelect,
      tagsDetails,
      el("label", { class: "checkbox-label", for: "include-deleted" }, [includeDeletedCheckbox, " Include deleted"]),
      el("label", { class: "checkbox-label", for: "include-superseded" }, [
        includeSupersededCheckbox,
        " Include superseded",
      ]),
      pageSizeSelect,
    ]);
  }

  function renderBulkBar(): HTMLElement | null {
    if (selected.size === 0) return null;
    const forgetBtn = el("button", { type: "button", class: "btn" }, ["Forget selected"]);
    forgetBtn.addEventListener("click", () => void handleBulkForget());
    const restoreBtn = el("button", { type: "button", class: "btn" }, ["Restore selected"]);
    restoreBtn.addEventListener("click", () => void handleBulkRestore());
    const clearBtn = el("button", { type: "button", class: "btn btn-quiet" }, ["Clear selection"]);
    clearBtn.addEventListener("click", () => {
      selected.clear();
      render();
    });
    return el("div", { class: "bulk-bar" }, [
      el("span", {}, [`${selected.size} selected`]),
      forgetBtn,
      restoreBtn,
      clearBtn,
    ]);
  }

  function rowStatus(row: Row): { label: string; className: string } | null {
    if (row.deletedAt !== null) return { label: "Deleted", className: "badge badge-deleted" };
    if (row.validUntil !== null) return { label: "Superseded", className: "badge badge-superseded" };
    return null;
  }

  function renderEditRow(row: Row): HTMLElement {
    const draft = editDraft;
    if (!draft) return el("tr");
    const textArea = el("textarea", { class: "edit-text", "aria-label": "Memory text" }, [draft.text]) as HTMLTextAreaElement;
    textArea.value = draft.text;
    textArea.addEventListener("input", () => {
      draft.text = textArea.value;
    });
    const tagsInput = el("input", {
      type: "text",
      class: "edit-tags",
      "aria-label": "Comma-separated tags",
      value: draft.tags,
    }) as HTMLInputElement;
    tagsInput.addEventListener("input", () => {
      draft.tags = tagsInput.value;
    });
    const importanceInput = el("input", {
      type: "number",
      class: "edit-importance",
      min: "0",
      max: "1",
      step: "0.01",
      "aria-label": "Importance, 0 to 1",
      value: draft.importance,
    }) as HTMLInputElement;
    importanceInput.addEventListener("input", () => {
      draft.importance = importanceInput.value;
    });
    const saveBtn = el("button", { type: "button", class: "btn" }, ["Save"]);
    saveBtn.addEventListener("click", () => void saveEdit(row.id));
    const cancelBtn = el("button", { type: "button", class: "btn btn-quiet" }, ["Cancel"]);
    cancelBtn.addEventListener("click", cancelEdit);

    return el("tr", { class: "editing-row" }, [
      el("td", {}, []),
      el("td", { colspan: "9" }, [
        el("div", { class: "edit-form" }, [
          el("label", { class: "field-label" }, ["Text", textArea]),
          el("div", { class: "edit-form-row" }, [
            el("label", { class: "field-label" }, ["Tags (comma-separated)", tagsInput]),
            el("label", { class: "field-label" }, ["Importance", importanceInput]),
          ]),
          editError ? el("p", { class: "field-error" }, [editError]) : null,
          el("div", { class: "edit-form-actions" }, [saveBtn, cancelBtn]),
        ]),
      ]),
    ]);
  }

  function renderRow(row: Row): HTMLElement[] {
    if (editingId === row.id) return [renderEditRow(row)];

    const checkbox = el("input", {
      type: "checkbox",
      "aria-label": `Select memory ${row.id}`,
      checked: selected.has(row.id) || undefined,
    }) as HTMLInputElement;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selected.add(row.id);
      else selected.delete(row.id);
      render();
    });

    const isExpanded = expanded.has(row.id);
    const textCell = el("td", { class: "cell-text" }, [
      el(
        "button",
        {
          type: "button",
          class: `text-toggle ${isExpanded ? "expanded" : "truncated"}`,
          title: row.text,
        },
        [row.text],
      ),
    ]);
    (textCell.firstElementChild as HTMLButtonElement).addEventListener("click", () => {
      if (isExpanded) expanded.delete(row.id);
      else expanded.add(row.id);
      render();
    });

    const status = rowStatus(row);
    const editBtn = el("button", { type: "button", class: "btn btn-quiet btn-small" }, ["Edit"]);
    editBtn.addEventListener("click", () => startEdit(row));
    const deleteBtn = el("button", { type: "button", class: "btn btn-quiet btn-small" }, ["Delete"]);
    deleteBtn.addEventListener("click", () => void handleDelete(row.id));
    const restoreBtn = el("button", { type: "button", class: "btn btn-quiet btn-small" }, ["Restore"]);
    restoreBtn.addEventListener("click", () => void handleRestore(row.id));

    const actions: HTMLElement[] = [editBtn];
    if (row.deletedAt !== null) actions.push(restoreBtn);
    else actions.push(deleteBtn);

    const tr = el(
      "tr",
      { class: status ? `row-${status.className.split(" ")[1]}` : undefined },
      [
        el("td", {}, [checkbox]),
        textCell,
        el("td", {}, [row.scope]),
        el("td", { class: "cell-tags" }, [row.tags.join(", ") || "—"]),
        el("td", {}, [row.importance.toFixed(2)]),
        el("td", {}, [row.sourceClient ?? "—"]),
        el("td", {}, [formatDate(row.createdAt)]),
        el("td", {}, [formatDate(row.updatedAt)]),
        el("td", {}, [status ? el("span", { class: status.className }, [status.label]) : text("—")]),
        el("td", { class: "cell-actions" }, actions),
      ],
    );
    return [tr];
  }

  function renderTable(): HTMLElement {
    const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
    const selectAll = el("input", {
      type: "checkbox",
      "aria-label": "Select all rows on this page",
      checked: allChecked || undefined,
    }) as HTMLInputElement;
    selectAll.addEventListener("change", () => {
      if (selectAll.checked) {
        for (const r of rows) selected.add(r.id);
      } else {
        for (const r of rows) selected.delete(r.id);
      }
      render();
    });

    const thead = el("thead", {}, [
      el("tr", {}, [
        el("th", { scope: "col" }, [selectAll]),
        el("th", { scope: "col" }, ["Text"]),
        el("th", { scope: "col" }, ["Scope"]),
        el("th", { scope: "col" }, ["Tags"]),
        el("th", { scope: "col" }, ["Importance"]),
        el("th", { scope: "col" }, ["Source"]),
        el("th", { scope: "col" }, ["Created"]),
        el("th", { scope: "col" }, ["Updated"]),
        el("th", { scope: "col" }, ["Status"]),
        el("th", { scope: "col" }, ["Actions"]),
      ]),
    ]);

    const tbody = el("tbody", {}, rows.flatMap(renderRow));
    return el("div", { class: "table-scroll" }, [el("table", { class: "memories-table" }, [thead, tbody])]);
  }

  function renderPager(): HTMLElement {
    if (mode === "search") {
      const atCap = rows.length >= SEARCH_RESULT_CAP;
      return el("div", { class: "pager" }, [
        el("span", { class: "muted" }, [
          atCap
            ? `Showing the top ${SEARCH_RESULT_CAP} matches; narrow your search to see more.`
            : `Showing the top ${rows.length} match${rows.length === 1 ? "" : "es"}.`,
        ]),
        degraded
          ? el("span", { class: "muted" }, [` Vector search degraded: ${degradedReason ?? "unknown reason"}.`])
          : null,
      ]);
    }
    const prevBtn = el("button", { type: "button", class: "btn btn-quiet", disabled: cursorHistory.length === 0 || undefined }, [
      "Previous",
    ]) as HTMLButtonElement;
    prevBtn.disabled = cursorHistory.length === 0;
    prevBtn.addEventListener("click", () => {
      const prev = cursorHistory.pop();
      cursor = prev ?? null;
      void load();
    });
    const nextBtn = el("button", { type: "button", class: "btn btn-quiet", disabled: nextCursor === null || undefined }, [
      "Next",
    ]) as HTMLButtonElement;
    nextBtn.disabled = nextCursor === null;
    nextBtn.addEventListener("click", () => {
      cursorHistory.push(cursor);
      cursor = nextCursor;
      void load();
    });
    return el("div", { class: "pager" }, [prevBtn, nextBtn]);
  }

  function renderEmptyState(): HTMLElement {
    if (filtersActive()) {
      return el("div", { class: "empty-state" }, [
        el("p", {}, ["No memories match your filters."]),
        el("p", { class: "muted" }, ["Try clearing a filter or searching for something broader."]),
      ]);
    }
    return el("div", { class: "empty-state" }, [
      el("p", {}, ["No memories yet."]),
      el("p", { class: "muted" }, [
        "Memories are created automatically when a connected MCP client (Claude, Cursor, ...) calls ",
        el("code", {}, ["remember"]),
        ". There is nothing to do here yet — go use the client you connected.",
      ]),
    ]);
  }

  function renderToast(): HTMLElement | null {
    if (!toast) return null;
    const actionBtn = toast.actionLabel
      ? el("button", { type: "button", class: "btn btn-toast-action" }, [toast.actionLabel])
      : null;
    if (actionBtn && toast.onAction) {
      const action = toast.onAction;
      actionBtn.addEventListener("click", () => {
        action();
        if (toastTimer) clearTimeout(toastTimer);
        toast = null;
        render();
      });
    }
    const closeBtn = el("button", { type: "button", class: "toast-close", "aria-label": "Dismiss" }, ["×"]);
    closeBtn.addEventListener("click", () => {
      if (toastTimer) clearTimeout(toastTimer);
      toast = null;
      render();
    });
    return el("div", { class: "toast", role: "status" }, [
      el("span", {}, [toast.message]),
      actionBtn,
      closeBtn,
    ]);
  }

  function render(): void {
    if (destroyed) return;
    clear(container);

    const toolbar = renderToolbar();
    const bulkBar = renderBulkBar();

    let body: HTMLElement;
    if (loading && rows.length === 0) {
      body = el("div", { class: "state-panel" }, [el("p", {}, ["Loading memories…"])]);
    } else if (error) {
      const retryBtn = el("button", { type: "button", class: "btn" }, ["Retry"]);
      retryBtn.addEventListener("click", () => void load());
      body = el("div", { class: "state-panel state-error" }, [el("p", {}, [error]), retryBtn]);
    } else if (rows.length === 0) {
      body = renderEmptyState();
    } else {
      body = el("div", {}, [renderTable(), renderPager()]);
    }

    const toastEl = renderToast();

    container.appendChild(
      el("div", { class: "memories-view" }, [
        toolbar,
        bulkBar,
        el("div", { class: "table-container" }, [body]),
        toastEl,
      ]),
    );
  }

  render();
  void loadFilterOptions();
  void load();

  return () => {
    destroyed = true;
    unsubscribeEvents();
    if (searchDebounce) clearTimeout(searchDebounce);
    if (toastTimer) clearTimeout(toastTimer);
  };
}
