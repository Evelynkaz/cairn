// The Memories view: BUILD_BRIEF §9's hero screenshot. A dense, editable,
// paginated table over GET /api/memories, with bulk forget/restore + undo,
// inline edit, and unobtrusive live refresh via the SSE stream.

import { el, clear, text } from "../dom.js";
import {
  listMemories,
  getStats,
  getClients,
  patchMemory,
  deleteMemory,
  restoreMemory,
  supersedeMemory,
  importPasted,
  importChatGpt,
  bulkOp,
  subscribeToEvents,
  ApiError,
} from "../api-client.js";
import type { Memory, SearchHit, StatsResult, ClientInfo } from "../api-client.js";

const PAGE_SIZES = [25, 50, 100] as const;
const SEARCH_DEBOUNCE_MS = 300;
const TOAST_DURATION_MS = 8000;
// Mirrors MAX_LIMIT in src/retrieval/search.ts -- search results are
// hard-capped there regardless of the requested page size, so a result set
// at this size must say so rather than silently look complete.
const SEARCH_RESULT_CAP = 50;
// Mirrors MAX_REQUEST_BODY_BYTES in src/daemon/http.ts -- the daemon rejects
// anything bigger with a 413 regardless of what this panel does, so a file
// over this size must never even be read, let alone sent.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

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
  return new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

// Date inputs hand back a bare "YYYY-MM-DD" with no timezone attached --
// interpreted here as a calendar day in the browser's own local timezone
// (matching the day the user actually clicked), not UTC.
function startOfLocalDay(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime();
}

// The calendar day AFTER dateStr's, at local midnight. Deliberately not
// `startOfLocalDay(dateStr) + 24*60*60*1000`: a DST fall-back day (e.g.
// Europe/Berlin, 2026-10-25) is 25 hours long, so adding a fixed 24h lands
// an hour before next midnight and silently drops that hour's entries.
// Letting the Date constructor roll `d + 1` over into the next month/year
// itself is what makes this correct across a month or DST boundary.
function startOfNextLocalDay(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1).getTime();
}

interface Toast {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

// Reconciles `parent`'s children to exactly `desired`, in order, without
// ever removing-then-reinserting a node that is already positioned
// correctly. That last part is load-bearing: a node that stays attached to
// this same, already-connected parent throughout never gets disconnected
// from the document, so a focused/edited element inside it (e.g. the inline
// edit row's textarea) keeps both focus and caret position across a
// refresh instead of only "looking" preserved.
function reconcileChildren(parent: HTMLElement, desired: HTMLElement[]): void {
  const desiredSet = new Set<Node>(desired);
  for (const child of Array.from(parent.children)) {
    if (!desiredSet.has(child)) parent.removeChild(child);
  }
  let ref: ChildNode | null = parent.firstChild;
  for (const node of desired) {
    if (ref === node) {
      ref = ref.nextSibling;
    } else {
      parent.insertBefore(node, ref);
    }
  }
}

export function mountMemoriesView(container: HTMLElement): () => void {
  // --- filter / paging state -------------------------------------------------
  let q = "";
  let scope = "";
  let selectedTags = new Set<string>();
  let sourceClient = "";
  let sinceDate = "";
  let untilDate = "";
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
  let clientsForFilters: ClientInfo[] | null = null;

  const selected = new Set<string>();
  const expanded = new Set<string>();
  let editingId: string | null = null;
  let editDraft: { text: string; tags: string; importance: string } | null = null;
  let editError: string | null = null;
  // The inline edit row's own DOM node and error slot, built once per edit
  // session and reused on every subsequent render -- see renderEditRow.
  let editRowNode: HTMLElement | null = null;
  let editRowErrorSlot: HTMLElement | null = null;

  let supersedingId: string | null = null;
  let supersedeDraft: { text: string; tags: string; importance: string } | null = null;
  let supersedeError: string | null = null;
  // Same rationale as editRowNode/editRowErrorSlot above -- see
  // renderSupersedeRow.
  let supersedeRowNode: HTMLElement | null = null;
  let supersedeRowErrorSlot: HTMLElement | null = null;

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
    updateScopeOptions();
    updateTagOptions();
  }

  async function loadClientOptions(): Promise<void> {
    try {
      const result = await getClients();
      clientsForFilters = result.clients;
    } catch {
      clientsForFilters = null;
    }
    updateSourceClientOptions();
  }

  function filtersActive(): boolean {
    return (
      q.trim() !== "" ||
      scope !== "" ||
      selectedTags.size > 0 ||
      sourceClient !== "" ||
      sinceDate !== "" ||
      untilDate !== "" ||
      includeDeleted ||
      includeSuperseded
    );
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
        sourceClient: sourceClient || undefined,
        since: sinceDate ? startOfLocalDay(sinceDate) : undefined,
        // `until` is exclusive (see ListMemoriesParams), so a "to" date
        // picked by the user must reach one day past midnight to include
        // that whole day's memories.
        until: untilDate ? startOfNextLocalDay(untilDate) : undefined,
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

  function resetEditState(): void {
    editingId = null;
    editDraft = null;
    editError = null;
    editRowNode = null;
    editRowErrorSlot = null;
  }

  function resetSupersedeState(): void {
    supersedingId = null;
    supersedeDraft = null;
    supersedeError = null;
    supersedeRowNode = null;
    supersedeRowErrorSlot = null;
  }

  function startEdit(row: Row): void {
    resetSupersedeState();
    editingId = row.id;
    editError = null;
    editDraft = {
      text: row.text,
      tags: row.tags.join(", "),
      importance: String(row.importance),
    };
    editRowNode = null;
    editRowErrorSlot = null;
    render();
  }

  function cancelEdit(): void {
    resetEditState();
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
      resetEditState();
      await load();
    } catch (err) {
      editError =
        err instanceof ApiError
          ? err.status === 409
            ? err.reason === "superseded"
              ? "This memory has been superseded and can no longer be edited."
              : "A live memory with that exact text already exists."
            : err.message
          : "Could not save that edit.";
      render();
    }
  }

  function startSupersede(row: Row): void {
    resetEditState();
    supersedingId = row.id;
    supersedeError = null;
    supersedeDraft = {
      text: row.text,
      tags: row.tags.join(", "),
      importance: String(row.importance),
    };
    supersedeRowNode = null;
    supersedeRowErrorSlot = null;
    render();
  }

  function cancelSupersede(): void {
    resetSupersedeState();
    render();
  }

  async function saveSupersede(id: string): Promise<void> {
    if (!supersedeDraft) return;
    const importanceNum = Number(supersedeDraft.importance);
    if (!Number.isFinite(importanceNum) || importanceNum < 0 || importanceNum > 1) {
      supersedeError = "Importance must be a number between 0 and 1.";
      render();
      return;
    }
    const replacementText = supersedeDraft.text.trim();
    if (replacementText.length === 0) {
      supersedeError = "Replacement text is required.";
      render();
      return;
    }
    const tags = supersedeDraft.tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    try {
      await supersedeMemory(id, { text: replacementText, tags, importance: importanceNum });
      resetSupersedeState();
      await load();
    } catch (err) {
      supersedeError =
        err instanceof ApiError
          ? err.status === 409
            ? "A live memory with that exact text already exists."
            : err.message
          : "Could not supersede that memory.";
      render();
    }
  }

  // --- live updates ----------------------------------------------------------

  const unsubscribeEvents = subscribeToEvents(() => {
    // Never clobber a field the user is actively editing: skip the
    // background refresh entirely while an inline edit is open, rather
    // than reconciling a partial merge. The next SSE event (or the user's
    // own save/cancel) resumes normal refreshing.
    if (editingId !== null || supersedingId !== null) return;
    void load();
  });

  // --- toolbar (built once; see render()'s comment for why) ------------------

  const searchInput = el("input", {
    type: "search",
    class: "search-input",
    placeholder: "Search memories…",
    "aria-label": "Search memories",
    value: q,
  }) as HTMLInputElement;

  const scopeSelect = el("select", { class: "scope-select", "aria-label": "Filter by scope" }, [
    el("option", { value: "" }, ["All scopes"]),
  ]) as HTMLSelectElement;
  scopeSelect.addEventListener("change", () => {
    scope = scopeSelect.value;
    resetPagingAndLoad();
  });

  const tagFieldset = el("fieldset", { class: "tag-fieldset" }, [el("legend", {}, ["Tags"])]);
  const tagsSummary = el("summary", {}, ["Tags"]);
  const tagsDetails = el("details", { class: "tags-picker" }, [tagsSummary, tagFieldset]);

  const includeDeletedCheckbox = el("input", { type: "checkbox", id: "include-deleted" }) as HTMLInputElement;
  includeDeletedCheckbox.addEventListener("change", () => {
    includeDeleted = includeDeletedCheckbox.checked;
    resetPagingAndLoad();
  });
  const includeDeletedLabel = el("label", { class: "checkbox-label", for: "include-deleted" }, [
    includeDeletedCheckbox,
    " Include deleted",
  ]);

  const includeSupersededCheckbox = el("input", { type: "checkbox", id: "include-superseded" }) as HTMLInputElement;
  includeSupersededCheckbox.addEventListener("change", () => {
    includeSuperseded = includeSupersededCheckbox.checked;
    resetPagingAndLoad();
  });
  const includeSupersededLabel = el("label", { class: "checkbox-label", for: "include-superseded" }, [
    includeSupersededCheckbox,
    " Include superseded",
  ]);

  const SEARCH_MODE_TITLE = "Search covers live memories only -- clear the search box to use this filter.";
  function updateSearchModeUI(): void {
    const inSearchMode = searchInput.value.trim() !== "";
    for (const [checkbox, label] of [
      [includeDeletedCheckbox, includeDeletedLabel],
      [includeSupersededCheckbox, includeSupersededLabel],
    ] as const) {
      checkbox.disabled = inSearchMode;
      if (inSearchMode) {
        checkbox.title = SEARCH_MODE_TITLE;
        label.setAttribute("aria-disabled", "true");
        label.title = SEARCH_MODE_TITLE;
      } else {
        checkbox.removeAttribute("title");
        label.removeAttribute("aria-disabled");
        label.removeAttribute("title");
      }
    }
  }

  searchInput.addEventListener("input", () => {
    q = searchInput.value;
    updateSearchModeUI();
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => resetPagingAndLoad(), SEARCH_DEBOUNCE_MS);
  });

  const sourceClientSelect = el("select", { class: "source-client-select", "aria-label": "Filter by source client" }, [
    el("option", { value: "" }, ["All clients"]),
  ]) as HTMLSelectElement;
  sourceClientSelect.addEventListener("change", () => {
    sourceClient = sourceClientSelect.value;
    resetPagingAndLoad();
  });

  const sinceInput = el("input", {
    type: "date",
    class: "since-input",
    "aria-label": "Created on or after this date",
  }) as HTMLInputElement;
  sinceInput.addEventListener("change", () => {
    sinceDate = sinceInput.value;
    resetPagingAndLoad();
  });

  const untilInput = el("input", {
    type: "date",
    class: "until-input",
    "aria-label": "Created on or before this date",
  }) as HTMLInputElement;
  untilInput.addEventListener("change", () => {
    untilDate = untilInput.value;
    resetPagingAndLoad();
  });

  const dateRange = el("span", { class: "date-range" }, [
    el("label", { class: "field-inline-label" }, ["From", sinceInput]),
    el("label", { class: "field-inline-label" }, ["To", untilInput]),
  ]);

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

  // --- import panel (BUILD_BRIEF §1/§12) -------------------------------
  // A panel inside this view, not a new nav section (the nav stays at six).

  let importPanelOpen = false;

  const importToggleBtn = el("button", { type: "button", class: "btn" }, ["Import memories"]);
  importToggleBtn.addEventListener("click", () => {
    importPanelOpen = !importPanelOpen;
    updateImportPanelVisibility();
  });

  const pastedTextArea = el("textarea", {
    class: "import-textarea",
    "aria-label": "Pasted memory text, one memory per line",
    rows: "6",
  }) as HTMLTextAreaElement;
  const pastedScopeInput = el("input", {
    type: "text",
    class: "import-scope",
    "aria-label": "Scope for the imported memories (optional)",
    placeholder: "Scope (optional)",
  }) as HTMLInputElement;
  const pastedTagsInput = el("input", {
    type: "text",
    class: "import-tags",
    "aria-label": "Tags for the imported memories, comma-separated (optional)",
    placeholder: "Tags, comma-separated (optional)",
  }) as HTMLInputElement;
  const pastedSubmitBtn = el("button", { type: "button", class: "btn" }, ["Import pasted text"]);
  const pastedResultSlot = el("div", { class: "field-error-slot" }, []);
  pastedSubmitBtn.addEventListener("click", () => void handlePastedImport());

  async function handlePastedImport(): Promise<void> {
    const rawText = pastedTextArea.value;
    if (rawText.trim() === "") return;
    const scope = pastedScopeInput.value.trim() || undefined;
    const tags = pastedTagsInput.value
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    pastedSubmitBtn.disabled = true;
    clear(pastedResultSlot);
    try {
      const result = await importPasted({ text: rawText, scope, tags: tags.length > 0 ? tags : undefined });
      pastedTextArea.value = "";
      pastedScopeInput.value = "";
      pastedTagsInput.value = "";
      const parts = [`Imported ${result.imported}, skipped ${result.skipped} as duplicate.`];
      if (result.refused > 0) {
        parts.push(` ${result.refused} line${result.refused === 1 ? "" : "s"} refused by strict redaction mode.`);
      }
      pastedResultSlot.appendChild(el("p", { class: "import-result" }, [parts.join("")]));
      await load();
    } catch (err) {
      pastedResultSlot.appendChild(
        el("p", { class: "field-error" }, [err instanceof ApiError ? err.message : "Could not import that text."]),
      );
    } finally {
      pastedSubmitBtn.disabled = false;
    }
  }

  const chatgptFileInput = el("input", {
    type: "file",
    accept: "application/json,.json",
    class: "import-file",
    "aria-label": "ChatGPT conversations.json export file",
  }) as HTMLInputElement;
  const chatgptScopeInput = el("input", {
    type: "text",
    class: "import-scope",
    "aria-label": "Scope for the imported memories (optional)",
    placeholder: "Scope (optional)",
  }) as HTMLInputElement;
  const chatgptSubmitBtn = el("button", { type: "button", class: "btn" }, ["Import ChatGPT export"]);
  const chatgptResultSlot = el("div", { class: "field-error-slot" }, []);
  chatgptSubmitBtn.addEventListener("click", () => void handleChatGptImport());

  async function handleChatGptImport(): Promise<void> {
    const file = chatgptFileInput.files?.[0];
    if (!file) return;
    chatgptSubmitBtn.disabled = true;
    clear(chatgptResultSlot);
    // Checked BEFORE reading the file: the daemon caps a request body at 4MB
    // (src/daemon/http.ts) and a real ChatGPT export is typically 5-100MB,
    // so every upload past this limit would fail with a 413 anyway -- but
    // only after paying for file.text() + JSON.parse + JSON.stringify, up to
    // three copies of the file in memory. Reject it here instead and point
    // the user at the paste path, which has no such ceiling.
    if (file.size > MAX_UPLOAD_BYTES) {
      chatgptResultSlot.appendChild(
        el("p", { class: "field-error" }, [
          `That file is larger than the ${(MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0)}MB upload limit. ` +
            "Copy the custom-instructions text out of ChatGPT's settings and use \"Paste memories\" above instead.",
        ]),
      );
      chatgptSubmitBtn.disabled = false;
      return;
    }
    try {
      const raw = await file.text();
      let conversations: unknown;
      try {
        conversations = JSON.parse(raw);
      } catch {
        chatgptResultSlot.appendChild(el("p", { class: "field-error" }, ["That file is not valid JSON."]));
        return;
      }
      const scope = chatgptScopeInput.value.trim() || undefined;
      const result = await importChatGpt({ conversations, scope });
      chatgptFileInput.value = "";
      chatgptScopeInput.value = "";
      const parts = [
        `Found ${result.found} of 2 known fields. Imported ${result.imported}, skipped ${result.skipped} as duplicate.`,
      ];
      if (result.refused > 0) {
        parts.push(` ${result.refused} field${result.refused === 1 ? "" : "s"} refused by strict redaction mode.`);
      }
      chatgptResultSlot.appendChild(el("p", { class: "import-result" }, [parts.join("")]));
      await load();
    } catch (err) {
      chatgptResultSlot.appendChild(
        el("p", { class: "field-error" }, [err instanceof ApiError ? err.message : "Could not import that export."]),
      );
    } finally {
      chatgptSubmitBtn.disabled = false;
    }
  }

  const importPanelEl = el("div", { class: "import-panel" }, [
    el("div", { class: "import-panel-section" }, [
      el("h3", {}, ["Paste memories"]),
      el("p", { class: "muted" }, [
        "One memory per line; leading bullets and numbered-list markers are stripped. Neither ChatGPT nor Claude includes memory in its data export, so copying the text out of the product's own settings screen is the only way to get it today. Up to 500 lines, 2000 characters each.",
      ]),
      el("label", { class: "field-label" }, ["Text", pastedTextArea]),
      el("div", { class: "edit-form-row" }, [
        el("label", { class: "field-label" }, ["Scope", pastedScopeInput]),
        el("label", { class: "field-label" }, ["Tags", pastedTagsInput]),
      ]),
      pastedResultSlot,
      pastedSubmitBtn,
    ]),
    el("div", { class: "import-panel-section" }, [
      el("h3", {}, ["ChatGPT export"]),
      el("p", { class: "muted" }, [
        "Upload a conversations.json file up to 4MB from a ChatGPT data export. Only its custom-instructions fields (about you, about the model) are imported -- no conversation content is read. A real export is often much larger than 4MB; if yours is rejected, copy the custom-instructions text out of ChatGPT's settings and use \"Paste memories\" instead.",
      ]),
      el("label", { class: "field-label" }, ["conversations.json", chatgptFileInput]),
      el("label", { class: "field-label" }, ["Scope", chatgptScopeInput]),
      chatgptResultSlot,
      chatgptSubmitBtn,
    ]),
  ]);
  const importPanelSlot = el("div", {}, []);

  function updateImportPanelVisibility(): void {
    clear(importToggleBtn);
    importToggleBtn.appendChild(text(importPanelOpen ? "Hide import" : "Import memories"));
    if (importPanelOpen) {
      if (!importPanelEl.parentNode) importPanelSlot.appendChild(importPanelEl);
    } else if (importPanelEl.parentNode) {
      importPanelSlot.removeChild(importPanelEl);
    }
  }

  const toolbarEl = el("div", { class: "toolbar" }, [
    searchInput,
    scopeSelect,
    tagsDetails,
    sourceClientSelect,
    dateRange,
    includeDeletedLabel,
    includeSupersededLabel,
    pageSizeSelect,
    importToggleBtn,
  ]);

  function updateScopeOptions(): void {
    clear(scopeSelect);
    scopeSelect.appendChild(el("option", { value: "" }, ["All scopes"]));
    for (const s of statsForFilters?.scopes ?? []) {
      scopeSelect.appendChild(el("option", { value: s.scope }, [`${s.scope} (${s.count})`]));
    }
    scopeSelect.value = scope;
  }

  function updateTagOptions(): void {
    clear(tagFieldset);
    tagFieldset.appendChild(el("legend", {}, ["Tags"]));
    for (const t of statsForFilters?.topTags ?? []) {
      const checkbox = el("input", {
        type: "checkbox",
        id: `tag-${t.tag}`,
        checked: selectedTags.has(t.tag) || undefined,
      }) as HTMLInputElement;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedTags.add(t.tag);
        else selectedTags.delete(t.tag);
        clear(tagsSummary);
        tagsSummary.appendChild(text(selectedTags.size > 0 ? `Tags (${selectedTags.size})` : "Tags"));
        resetPagingAndLoad();
      });
      tagFieldset.appendChild(el("label", { class: "tag-option", for: `tag-${t.tag}` }, [checkbox, ` ${t.tag} (${t.count})`]));
    }
    clear(tagsSummary);
    tagsSummary.appendChild(text(selectedTags.size > 0 ? `Tags (${selectedTags.size})` : "Tags"));
  }

  function updateSourceClientOptions(): void {
    clear(sourceClientSelect);
    sourceClientSelect.appendChild(el("option", { value: "" }, ["All clients"]));
    for (const c of clientsForFilters ?? []) {
      sourceClientSelect.appendChild(el("option", { value: c.id }, [c.name || c.id]));
    }
    sourceClientSelect.value = sourceClient;
  }

  // --- persistent table structure (see render()'s comment for why) -----------

  const selectAllCheckbox = el("input", {
    type: "checkbox",
    "aria-label": "Select all rows on this page",
  }) as HTMLInputElement;
  selectAllCheckbox.addEventListener("change", () => {
    if (selectAllCheckbox.checked) {
      for (const r of rows) selected.add(r.id);
    } else {
      for (const r of rows) selected.delete(r.id);
    }
    render();
  });

  const theadEl = el("thead", {}, [
    el("tr", {}, [
      el("th", { scope: "col" }, [selectAllCheckbox]),
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
  const tbodyEl = el("tbody", {}, []);
  const tableEl = el("table", { class: "memories-table" }, [theadEl, tbodyEl]);
  const tableWrapperEl = el("div", { class: "table-scroll" }, [tableEl]);
  const pagerSlot = el("div", {});
  const tableSectionEl = el("div", {}, [tableWrapperEl, pagerSlot]);
  const stateSlot = el("div", {});
  const tableContainerEl = el("div", { class: "table-container" });

  const bulkBarSlot = el("div", {});
  const toastSlot = el("div", {});

  container.appendChild(
    el("div", { class: "memories-view" }, [toolbarEl, importPanelSlot, bulkBarSlot, tableContainerEl, toastSlot]),
  );

  // --- rendering ---------------------------------------------------------

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

  function updateEditRowError(): void {
    if (!editRowErrorSlot) return;
    clear(editRowErrorSlot);
    if (editError) editRowErrorSlot.appendChild(el("p", { class: "field-error" }, [editError]));
  }

  // Built once per edit session and cached in `editRowNode`: every
  // subsequent call (from a render triggered by, say, the toast timer or an
  // unrelated row's checkbox) returns the exact same DOM node instead of a
  // fresh one, so the textarea inside it is never removed from the
  // document and its focus/caret survive untouched.
  function renderEditRow(row: Row): HTMLElement {
    const draft = editDraft;
    if (!draft) return el("tr");
    if (!editRowNode) {
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

      editRowErrorSlot = el("div", { class: "field-error-slot" }, []);
      editRowNode = el("tr", { class: "editing-row" }, [
        el("td", {}, []),
        el("td", { colspan: "9" }, [
          el("div", { class: "edit-form" }, [
            el("label", { class: "field-label" }, ["Text", textArea]),
            el("div", { class: "edit-form-row" }, [
              el("label", { class: "field-label" }, ["Tags (comma-separated)", tagsInput]),
              el("label", { class: "field-label" }, ["Importance", importanceInput]),
            ]),
            editRowErrorSlot,
            el("div", { class: "edit-form-actions" }, [saveBtn, cancelBtn]),
          ]),
        ]),
      ]);
    }
    updateEditRowError();
    return editRowNode;
  }

  function updateSupersedeRowError(): void {
    if (!supersedeRowErrorSlot) return;
    clear(supersedeRowErrorSlot);
    if (supersedeError) supersedeRowErrorSlot.appendChild(el("p", { class: "field-error" }, [supersedeError]));
  }

  // Same caching rationale as renderEditRow above.
  function renderSupersedeRow(row: Row): HTMLElement {
    const draft = supersedeDraft;
    if (!draft) return el("tr");
    if (!supersedeRowNode) {
      const textArea = el(
        "textarea",
        { class: "edit-text", "aria-label": "Replacement memory text" },
        [draft.text],
      ) as HTMLTextAreaElement;
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
      const saveBtn = el("button", { type: "button", class: "btn" }, ["Supersede"]);
      saveBtn.addEventListener("click", () => void saveSupersede(row.id));
      const cancelBtn = el("button", { type: "button", class: "btn btn-quiet" }, ["Cancel"]);
      cancelBtn.addEventListener("click", cancelSupersede);

      supersedeRowErrorSlot = el("div", { class: "field-error-slot" }, []);
      supersedeRowNode = el("tr", { class: "editing-row" }, [
        el("td", {}, []),
        el("td", { colspan: "9" }, [
          el("div", { class: "edit-form" }, [
            el("p", { class: "muted supersede-hint" }, [
              "Superseding keeps this memory as history (marked with a valid-until date) instead of deleting it, and adds a new one in its place.",
            ]),
            el("label", { class: "field-label" }, ["Replacement text", textArea]),
            el("div", { class: "edit-form-row" }, [
              el("label", { class: "field-label" }, ["Tags (comma-separated)", tagsInput]),
              el("label", { class: "field-label" }, ["Importance", importanceInput]),
            ]),
            supersedeRowErrorSlot,
            el("div", { class: "edit-form-actions" }, [saveBtn, cancelBtn]),
          ]),
        ]),
      ]);
    }
    updateSupersedeRowError();
    return supersedeRowNode;
  }

  function renderRow(row: Row): HTMLElement[] {
    if (editingId === row.id) return [renderEditRow(row)];
    if (supersedingId === row.id) return [renderSupersedeRow(row)];

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
    const supersedeBtn = el("button", { type: "button", class: "btn btn-quiet btn-small" }, ["Supersede"]);
    supersedeBtn.addEventListener("click", () => startSupersede(row));

    const actions: HTMLElement[] = [editBtn];
    if (row.deletedAt !== null) {
      actions.push(restoreBtn);
    } else {
      actions.push(deleteBtn);
      // Superseding a row that's already superseded or deleted makes no
      // sense (only a live memory has this action) -- rowStatus above is
      // exactly the same "deleted or superseded" check used to pick the
      // status badge.
      if (row.validUntil === null) actions.push(supersedeBtn);
    }

    const tr = el(
      "tr",
      { class: status ? `row-${status.className.split(" ")[1]}` : undefined },
      [
        el("td", {}, [checkbox]),
        textCell,
        el("td", {}, [row.scope]),
        el("td", { class: "cell-tags" }, [row.tags.join(", ") || "—"]),
        el("td", {}, [row.importance.toFixed(2)]),
        el("td", { class: "cell-source" }, [row.sourceClient ?? "—"]),
        el("td", { class: "cell-timestamp" }, [formatDate(row.createdAt)]),
        el("td", { class: "cell-timestamp" }, [formatDate(row.updatedAt)]),
        el("td", {}, [status ? el("span", { class: status.className }, [status.label]) : text("—")]),
        el("td", { class: "cell-actions" }, [el("div", { class: "cell-actions-inner" }, actions)]),
      ],
    );
    return [tr];
  }

  function updateSelectAllCheckbox(): void {
    selectAllCheckbox.checked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  }

  function updateTbody(): void {
    updateSelectAllCheckbox();
    reconcileChildren(tbodyEl, rows.flatMap(renderRow));
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

  // Shows either the state panel (loading/error/empty) or the table
  // section, without ever tearing down and recreating whichever one stays
  // visible -- see reconcileChildren's comment for why that matters.
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
    if (loading && rows.length === 0) {
      clear(stateSlot);
      stateSlot.appendChild(el("div", { class: "state-panel" }, [el("p", {}, ["Loading memories…"])]));
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
      updateTbody();
      clear(pagerSlot);
      pagerSlot.appendChild(renderPager());
    }
  }

  // Only the parts of the view that can actually change get rebuilt here:
  // the bulk bar, the table body, the pager and the toast. The toolbar is
  // built exactly once above and never touched again, and the row
  // currently under edit is never recreated (see renderEditRow) -- so
  // neither a debounced search reload, an SSE-triggered refresh, nor an
  // unrelated row's checkbox toggling can steal focus or reset a caret
  // position the way rebuilding the whole view from scratch used to.
  function render(): void {
    if (destroyed) return;
    clear(bulkBarSlot);
    const bulkBar = renderBulkBar();
    if (bulkBar) bulkBarSlot.appendChild(bulkBar);

    updateBody();

    clear(toastSlot);
    const toastEl = renderToast();
    if (toastEl) toastSlot.appendChild(toastEl);
  }

  updateScopeOptions();
  updateTagOptions();
  updateSourceClientOptions();
  updateSearchModeUI();
  updateImportPanelVisibility();
  render();
  void loadFilterOptions();
  void loadClientOptions();
  void load();

  return () => {
    destroyed = true;
    unsubscribeEvents();
    if (searchDebounce) clearTimeout(searchDebounce);
    if (toastTimer) clearTimeout(toastTimer);
  };
}
