// The Privacy view: redaction mode, redaction findings, and the
// irreversible "delete everything" escape hatch (BUILD_BRIEF §10).

import { el, clear } from "../dom.js";
import {
  getPrivacy,
  putPrivacy,
  getRedactions,
  deleteEverything,
  ApiError,
} from "../api-client.js";
import type { PrivacyMode, PrivacyState, RedactionEntry } from "../api-client.js";

const REDACTIONS_PAGE_SIZE = 25;
const DELETE_CONFIRM_WORD = "DELETE";

const MODE_DESCRIPTIONS: Record<PrivacyMode, string> = {
  off: "Secrets are stored exactly as written. Detectors do not even run.",
  on: "Detected secrets are replaced with a [redacted:<kind>] marker before the memory is stored.",
  strict: "Detected secrets block the write entirely. Nothing is stored and nothing is redacted-and-kept.",
};

const SOURCE_LABELS: Record<string, string> = {
  env: "set by the CAIRN_PRIVACY environment variable",
  settings: "set from the dashboard",
  default: "the untouched default",
};

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

export function mountPrivacyView(container: HTMLElement): () => void {
  let destroyed = false;

  // --- privacy mode state ---------------------------------------------------
  let privacyState: PrivacyState | null = null;
  let privacyLoading = true;
  let privacyError: string | null = null;
  let privacySaving = false;

  // --- redactions state ------------------------------------------------------
  let redactions: RedactionEntry[] = [];
  let redactionsLoading = true;
  let redactionsError: string | null = null;
  let redactionsCursor: string | null = null;
  let redactionsCursorHistory: (string | null)[] = [];
  let redactionsNextCursor: string | null = null;
  // Guards against a stale response landing after a fresher request: only
  // the response matching the most recently issued requestId is applied.
  let redactionsRequestId = 0;

  // --- delete-everything state -----------------------------------------------
  let confirmText = "";
  let deleting = false;
  let deleteError: string | null = null;
  let deleteResult: { memories: number; episodes: number; vectors: number } | null = null;

  // --- loading ---------------------------------------------------------------

  async function loadPrivacy(): Promise<void> {
    privacyLoading = true;
    privacyError = null;
    render();
    try {
      const state = await getPrivacy();
      if (destroyed) return;
      privacyState = state;
    } catch (err) {
      if (destroyed) return;
      privacyError = err instanceof ApiError ? err.message : "Could not reach the daemon.";
    } finally {
      privacyLoading = false;
      if (!destroyed) render();
    }
  }

  async function loadRedactions(): Promise<void> {
    const myRequestId = ++redactionsRequestId;
    redactionsLoading = true;
    redactionsError = null;
    render();
    try {
      const result = await getRedactions({ limit: REDACTIONS_PAGE_SIZE, cursor: redactionsCursor ?? undefined });
      if (destroyed || myRequestId !== redactionsRequestId) return;
      redactions = result.items;
      redactionsNextCursor = result.nextCursor;
    } catch (err) {
      if (destroyed || myRequestId !== redactionsRequestId) return;
      redactionsError = err instanceof ApiError ? err.message : "Could not reach the daemon.";
    } finally {
      if (!destroyed && myRequestId === redactionsRequestId) {
        redactionsLoading = false;
        render();
      }
    }
  }

  // --- actions -----------------------------------------------------------

  async function handleSetMode(mode: PrivacyMode): Promise<void> {
    if (privacySaving || privacyState?.mode === mode) return;
    privacySaving = true;
    privacyError = null;
    render();
    try {
      // Always render what the server reports back after the write, never
      // the mode we optimistically asked for: a bug here once let the UI
      // claim "strict" while the store kept storing secrets verbatim.
      const state = await putPrivacy(mode);
      if (destroyed) return;
      privacyState = state;
    } catch (err) {
      if (destroyed) return;
      privacyError = err instanceof ApiError ? err.message : "Could not change the privacy mode.";
    } finally {
      privacySaving = false;
      if (!destroyed) render();
    }
  }

  async function handleDeleteEverything(): Promise<void> {
    if (deleting || confirmText !== DELETE_CONFIRM_WORD) return;
    deleting = true;
    deleteError = null;
    render();
    try {
      const result = await deleteEverything();
      if (destroyed) return;
      deleteResult = result;
      confirmText = "";
      confirmInput.value = "";
      redactionsCursor = null;
      redactionsCursorHistory = [];
      await Promise.all([loadPrivacy(), loadRedactions()]);
    } catch (err) {
      if (destroyed) return;
      deleteError = err instanceof ApiError ? err.message : "Could not delete everything.";
    } finally {
      deleting = false;
      if (!destroyed) render();
    }
  }

  // --- rendering: privacy mode ------------------------------------------------

  function renderModeSection(): HTMLElement {
    if (privacyLoading && !privacyState) {
      return el("div", { class: "state-panel" }, [el("p", {}, ["Loading privacy mode…"])]);
    }
    if (privacyError && !privacyState) {
      const retryBtn = el("button", { type: "button", class: "btn" }, ["Retry"]);
      retryBtn.addEventListener("click", () => void loadPrivacy());
      return el("div", { class: "state-panel state-error" }, [el("p", {}, [privacyError]), retryBtn]);
    }
    if (!privacyState) return el("div", { class: "state-panel" }, [el("p", {}, ["Nothing to show."])]);

    const modeButtons = (["off", "on", "strict"] as const).map((mode) => {
      const isActive = privacyState?.mode === mode;
      const btn = el(
        "button",
        {
          type: "button",
          class: `mode-option ${isActive ? "mode-option-active btn" : "btn btn-quiet"}`,
          disabled: privacySaving || undefined,
          "aria-pressed": isActive ? "true" : "false",
        },
        [
          el("strong", {}, [mode]),
          el("span", { class: "muted" }, [" — ", MODE_DESCRIPTIONS[mode]]),
          isActive ? el("span", { class: "mode-option-current" }, ["Current"]) : null,
        ],
      ) as HTMLButtonElement;
      btn.addEventListener("click", () => void handleSetMode(mode));
      return el("div", { class: "edit-form-row" }, [btn]);
    });

    const sourceLabel = privacyState.source in SOURCE_LABELS ? SOURCE_LABELS[privacyState.source] : privacyState.source;
    const sourceNote = el("p", { class: "muted" }, [
      `Current mode: ${privacyState.mode} (${sourceLabel}).`,
      privacyState.source === "env"
        ? " The dashboard cannot override an environment variable — unset CAIRN_PRIVACY to change it here."
        : "",
    ]);

    const errorNode = privacyError ? el("p", { class: "field-error" }, [privacyError]) : null;

    return el("div", { class: "edit-form" }, [sourceNote, ...modeButtons, errorNode]);
  }

  // --- rendering: redactions -------------------------------------------------

  function renderRedactionRow(entry: RedactionEntry): HTMLElement {
    return el("tr", {}, [
      el("td", {}, [entry.kind]),
      el("td", {}, [entry.preview]),
      el("td", {}, [entry.action]),
      el("td", { class: "cell-timestamp" }, [formatDate(entry.ts)]),
      el("td", {}, [entry.memoryId ?? "—"]),
    ]);
  }

  function renderRedactionsPager(): HTMLElement {
    const prevBtn = el("button", { type: "button", class: "btn btn-quiet" }, ["Previous"]) as HTMLButtonElement;
    prevBtn.disabled = redactionsLoading || redactionsCursorHistory.length === 0;
    prevBtn.addEventListener("click", () => {
      const prev = redactionsCursorHistory.pop();
      redactionsCursor = prev ?? null;
      void loadRedactions();
    });
    const nextBtn = el("button", { type: "button", class: "btn btn-quiet" }, ["Next"]) as HTMLButtonElement;
    nextBtn.disabled = redactionsLoading || redactionsNextCursor === null;
    nextBtn.addEventListener("click", () => {
      redactionsCursorHistory.push(redactionsCursor);
      redactionsCursor = redactionsNextCursor;
      void loadRedactions();
    });
    return el("div", { class: "pager" }, [prevBtn, nextBtn]);
  }

  function renderRedactionsSection(): HTMLElement {
    const maskedNote = el("p", { class: "muted" }, [
      "Previews are masked on purpose — the raw secret is never stored anywhere, so there is nothing to reveal.",
    ]);

    if (redactionsLoading && redactions.length === 0) {
      return el("div", {}, [maskedNote, el("div", { class: "state-panel" }, [el("p", {}, ["Loading findings…"])])]);
    }
    if (redactionsError) {
      const retryBtn = el("button", { type: "button", class: "btn" }, ["Retry"]);
      retryBtn.addEventListener("click", () => void loadRedactions());
      return el("div", {}, [maskedNote, el("div", { class: "state-panel state-error" }, [el("p", {}, [redactionsError]), retryBtn])]);
    }
    if (redactions.length === 0) {
      return el("div", {}, [
        maskedNote,
        el("div", { class: "empty-state" }, [
          el("p", {}, ["No secrets have been caught at ingest."]),
        ]),
      ]);
    }

    const table = el("table", { class: "memories-table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { scope: "col" }, ["Kind"]),
          el("th", { scope: "col" }, ["Preview"]),
          el("th", { scope: "col" }, ["Action"]),
          el("th", { scope: "col" }, ["When"]),
          el("th", { scope: "col" }, ["Memory"]),
        ]),
      ]),
      el("tbody", {}, redactions.map(renderRedactionRow)),
    ]);

    return el("div", {}, [
      maskedNote,
      el("div", { class: "table-scroll" }, [table]),
      renderRedactionsPager(),
    ]);
  }

  // --- rendering: delete everything -------------------------------------------

  // --- top-level layout --------------------------------------------------

  const modeSlot = el("div", {});
  const redactionsSlot = el("div", {});
  const deleteSlot = el("div", {});

  // Built once, like renderRow's toolbars in views/timeline.ts and
  // views/audit.ts: a render landing mid-keystroke must never replace the
  // focused confirmation input, or the rest of the typed word is lost.
  const confirmInput = el("input", {
    type: "text",
    "aria-label": `Type ${DELETE_CONFIRM_WORD} to confirm`,
    placeholder: DELETE_CONFIRM_WORD,
    value: confirmText,
  }) as HTMLInputElement;
  const deleteBtn = el("button", { type: "button", class: "btn danger-button" }, [
    "Delete everything",
  ]) as HTMLButtonElement;
  deleteBtn.disabled = true;
  confirmInput.addEventListener("input", () => {
    confirmText = confirmInput.value;
    deleteBtn.disabled = confirmText !== DELETE_CONFIRM_WORD || deleting;
  });
  deleteBtn.addEventListener("click", () => void handleDeleteEverything());

  const deleteErrorSlot = el("div", {});
  const deleteFormEl = el("div", { class: "danger-zone" }, [
    el("p", {}, [
      el("strong", {}, ["This is irreversible."]),
      " It permanently deletes every memory and the episodic log. It does not delete the audit trail or the redaction findings above — those exist so you can verify this deletion actually happened.",
    ]),
    el("label", { class: "field-label" }, [
      `Type ${DELETE_CONFIRM_WORD} to confirm`,
      confirmInput,
    ]),
    deleteErrorSlot,
    deleteBtn,
  ]);
  const deleteResultSlot = el("div", {});

  function renderDeleteResultPanel(): HTMLElement {
    const result = deleteResult;
    const resultPanel = el("div", { class: "empty-state" }, [
      el("p", {}, [
        `Deleted ${result?.memories ?? 0} ${result?.memories === 1 ? "memory" : "memories"}, `,
        `${result?.episodes ?? 0} ${result?.episodes === 1 ? "episode" : "episodes"}, and `,
        `${result?.vectors ?? 0} ${result?.vectors === 1 ? "vector" : "vectors"}.`,
      ]),
    ]);
    const okBtn = el("button", { type: "button", class: "btn btn-quiet" }, ["Done"]);
    okBtn.addEventListener("click", () => {
      deleteResult = null;
      render();
    });
    return el("div", { class: "danger-zone" }, [resultPanel, okBtn]);
  }

  function updateDeleteSection(): void {
    if (deleteResult) {
      if (deleteFormEl.parentNode) deleteSlot.removeChild(deleteFormEl);
      clear(deleteResultSlot);
      deleteResultSlot.appendChild(renderDeleteResultPanel());
      if (!deleteResultSlot.parentNode) deleteSlot.appendChild(deleteResultSlot);
      return;
    }
    if (deleteResultSlot.parentNode) deleteSlot.removeChild(deleteResultSlot);
    if (!deleteFormEl.parentNode) deleteSlot.appendChild(deleteFormEl);

    confirmInput.disabled = deleting;
    deleteBtn.textContent = deleting ? "Deleting…" : "Delete everything";
    // Re-derive from current state rather than trust the button's own
    // attribute: guards against a manually re-enabled button in devtools.
    deleteBtn.disabled = confirmText !== DELETE_CONFIRM_WORD || deleting;

    clear(deleteErrorSlot);
    if (deleteError) deleteErrorSlot.appendChild(el("p", { class: "field-error" }, [deleteError]));
  }

  container.appendChild(
    el("div", { class: "privacy-view" }, [
      el("section", {}, [el("h2", {}, ["Redaction mode"]), modeSlot]),
      el("section", { class: "privacy-view-section-wide" }, [el("h2", {}, ["Redaction findings"]), redactionsSlot]),
      el("section", {}, [el("h2", {}, ["Delete everything"]), deleteSlot]),
    ]),
  );

  function render(): void {
    if (destroyed) return;
    clear(modeSlot);
    modeSlot.appendChild(renderModeSection());
    clear(redactionsSlot);
    redactionsSlot.appendChild(renderRedactionsSection());
    updateDeleteSection();
  }

  render();
  void loadPrivacy();
  void loadRedactions();

  return () => {
    destroyed = true;
  };
}
