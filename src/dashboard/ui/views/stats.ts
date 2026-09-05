// The Stats view: a read-only dashboard over GET /api/stats, grouped into
// headline counts, ranked scope/tag lists, store health, and the redaction
// breakdown. Mirrors views/memories.ts's loading / error / empty states and
// its live refresh via subscribeToEvents.

import { el, clear } from "../dom.js";
import { getStats, subscribeToEvents, ApiError } from "../api-client.js";
import type { StatsResult } from "../api-client.js";

function formatDate(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

export function barWidthPercent(count: number, max: number): string {
  if (max <= 0) return "0%";
  return `${Math.round((count / max) * 100)}%`;
}

export function isEmpty(s: StatsResult): boolean {
  return (
    s.liveMemories === 0 &&
    s.deletedMemories === 0 &&
    s.supersededMemories === 0 &&
    s.episodes === 0
  );
}

export function mountStatsView(container: HTMLElement): () => void {
  let stats: StatsResult | null = null;
  let loading = true;
  let error: string | null = null;
  let destroyed = false;

  const stateSlot = el("div", {});
  const bodySlot = el("div", {});
  const rootEl = el("div", { class: "stats-view" }, [stateSlot, bodySlot]);
  container.appendChild(rootEl);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    render();
    try {
      const result = await getStats();
      if (destroyed) return;
      stats = result;
    } catch (err) {
      if (destroyed) return;
      error = err instanceof ApiError ? err.message : "Could not reach the daemon.";
    } finally {
      loading = false;
      if (!destroyed) render();
    }
  }

  const unsubscribeEvents = subscribeToEvents(() => {
    void load();
  });

  function renderStatCards(s: StatsResult): HTMLElement {
    const cards: Array<[string, number]> = [
      ["Live memories", s.liveMemories],
      ["Episodes", s.episodes],
      ["Deleted", s.deletedMemories],
      ["Superseded", s.supersededMemories],
      ["Redacted", s.redactedMemories],
      ["Active in last 30 days", s.recentActivity],
    ];
    return el(
      "div",
      { class: "stats-card-grid" },
      cards.map(([label, value]) =>
        el("div", { class: "stat" }, [
          el("div", { class: "stat-value" }, [String(value)]),
          el("div", { class: "stat-label" }, [label]),
        ]),
      ),
    );
  }

  function renderRankedList(
    title: string,
    rows: Array<{ label: string; count: number }>,
    emptyText: string,
  ): HTMLElement {
    if (rows.length === 0) {
      return el("section", { class: "stats-section" }, [
        el("h3", {}, [title]),
        el("p", { class: "muted" }, [emptyText]),
      ]);
    }
    const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
    return el("section", { class: "stats-section" }, [
      el("h3", {}, [title]),
      el(
        "ul",
        { class: "stats-rank-list" },
        rows.map((r) =>
          el("li", { class: "stats-rank-row" }, [
            el("span", { class: "stats-rank-label" }, [r.label]),
            el("span", { class: "stats-bar-track" }, [
              (() => {
                const fill = el("span", { class: "stats-bar-fill" }, []);
                // Set width via the CSSOM, not a `style` attribute: the daemon's CSP
                // is `style-src 'self'` with no 'unsafe-inline', so a `style="..."`
                // attribute parsed from markup is silently dropped. A programmatic
                // write to `.style.width` from trusted script is not affected.
                fill.style.width = barWidthPercent(r.count, max);
                return fill;
              })(),
            ]),
            el("span", { class: "stats-rank-count" }, [String(r.count)]),
          ]),
        ),
      ),
    ]);
  }

  const TOP_ROWS = 10;

  function renderStoreHealth(s: StatsResult): HTMLElement {
    const vectorsLine = s.vectors
      ? "Semantic (vector) search is available."
      : "Vectors are off: retrieval is keyword-only (FTS). This is a legitimate zero-config mode, not an error.";
    const journalMode = s.journalMode ?? "unknown";
    const journalOk = journalMode === "wal";
    const journalLine = journalOk
      ? "Journal mode is WAL, as expected."
      : `Journal mode is "${journalMode}", not WAL — worth flagging.`;
    return el("section", { class: "stats-section" }, [
      el("h3", {}, ["Store health"]),
      el("ul", { class: "stats-health-list" }, [
        el("li", { class: s.vectors ? undefined : "muted" }, [`Vectors: ${s.vectors ? "on" : "off"}. `, vectorsLine]),
        el("li", { class: journalOk ? undefined : "state-error" }, [`Journal mode: ${journalMode}. `, journalLine]),
      ]),
    ]);
  }

  function renderDateRange(s: StatsResult): HTMLElement {
    if (s.oldestCreatedAt === null || s.newestCreatedAt === null) {
      return el("section", { class: "stats-section" }, [
        el("h3", {}, ["Date range"]),
        el("p", { class: "muted" }, ["No memories yet."]),
      ]);
    }
    return el("section", { class: "stats-section" }, [
      el("h3", {}, ["Date range"]),
      el("p", { class: "date-range" }, [`${formatDate(s.oldestCreatedAt)} — ${formatDate(s.newestCreatedAt)}`]),
    ]);
  }

  function renderRedactions(s: StatsResult): HTMLElement {
    const rows = s.redactions;
    if (rows.length === 0) {
      return el("section", { class: "stats-section" }, [
        el("h3", {}, ["Redactions"]),
        el("p", { class: "muted" }, ["No redactions recorded."]),
      ]);
    }
    return el("section", { class: "stats-section" }, [
      el("h3", {}, ["Redactions"]),
      el(
        "ul",
        { class: "stats-redaction-list" },
        rows.map((r) =>
          el("li", { class: "stats-redaction-row" }, [
            el("span", { class: "stats-redaction-kind" }, [r.kind]),
            el("span", { class: "muted" }, [` ${r.action} `]),
            el("span", { class: "stats-rank-count" }, [String(r.count)]),
          ]),
        ),
      ),
    ]);
  }

  function renderBody(s: StatsResult): HTMLElement {
    const scopeRows = s.scopes.slice(0, TOP_ROWS).map((sc) => ({ label: sc.scope, count: sc.count }));
    const tagRows = s.topTags.slice(0, TOP_ROWS).map((t) => ({ label: t.tag, count: t.count }));
    return el("div", { class: "stats-body" }, [
      renderStatCards(s),
      el("div", { class: "stats-columns" }, [
        renderRankedList("Scopes", scopeRows, "No scopes yet."),
        renderRankedList("Top tags", tagRows, "No tags yet."),
      ]),
      renderStoreHealth(s),
      renderDateRange(s),
      renderRedactions(s),
    ]);
  }

  function render(): void {
    if (destroyed) return;
    clear(stateSlot);
    clear(bodySlot);

    if (loading && stats === null) {
      stateSlot.appendChild(el("div", { class: "state-panel" }, [el("p", {}, ["Loading stats…"])]));
      return;
    }
    if (error) {
      const retryBtn = el("button", { type: "button", class: "btn" }, ["Retry"]);
      retryBtn.addEventListener("click", () => void load());
      stateSlot.appendChild(el("div", { class: "state-panel state-error" }, [el("p", {}, [error]), retryBtn]));
      return;
    }
    if (!stats) return;
    if (isEmpty(stats)) {
      stateSlot.appendChild(
        el("div", { class: "empty-state" }, [
          el("p", {}, ["Nothing here yet."]),
          el("p", { class: "muted" }, [
            "Stats appear once a connected MCP client (Claude, Cursor, ...) calls ",
            el("code", {}, ["remember"]),
            ".",
          ]),
        ]),
      );
      return;
    }
    bodySlot.appendChild(renderBody(stats));
  }

  render();
  void load();

  return () => {
    destroyed = true;
    unsubscribeEvents();
  };
}
