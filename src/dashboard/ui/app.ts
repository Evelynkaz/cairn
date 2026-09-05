// Browser entrypoint: loaded by index.html as an ES module (tsc emits this
// file as-is, no bundler). Owns auth bootstrap, the sidebar shell, hash
// routing, and the header's headline numbers. The Memories view itself
// lives in views/memories.ts.

import { el, clear } from "./dom.js";
import { getToken, setToken, clearToken } from "./state.js";
import { getStats, setUnauthorizedHandler } from "./api-client.js";
import type { StatsResult } from "./api-client.js";
import { mountMemoriesView } from "./views/memories.js";

const SECTIONS = [
  { id: "memories", label: "Memories" },
  { id: "timeline", label: "Timeline" },
  { id: "access-log", label: "Access log" },
  { id: "clients", label: "Connected apps" },
  { id: "privacy", label: "Privacy" },
  { id: "stats", label: "Stats" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function isSectionId(value: string): value is SectionId {
  return SECTIONS.some((s) => s.id === value);
}

// Reads a `#token=...[&route=...]` fragment left by `cairn ui`
// (src/cli/lifecycle.ts's uiUrl()) or a bookmarked/re-pasted link that
// carries both a token and a route, stashes the token in sessionStorage,
// and immediately replaces the hash with just the route -- the token must
// never linger in the address bar, browser history, or a URL the user
// copies. The fragment is parsed as a query string (URLSearchParams), which
// is unambiguous about where "token" ends and "route" begins, unlike
// concatenating raw strings would be.
function bootstrapToken(): void {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("token");
  if (token === null) return;
  setToken(token);
  const route = params.get("route");
  const resolvedRoute = route && route.startsWith("/") ? route : "/memories";
  history.replaceState(null, "", `${location.pathname}${location.search}#${resolvedRoute}`);
}

function currentSection(): SectionId {
  const match = /^#\/([a-z-]+)/.exec(location.hash);
  const candidate = match?.[1];
  return candidate && isSectionId(candidate) ? candidate : "memories";
}

function renderNoToken(root: HTMLElement): void {
  clear(root);
  root.appendChild(
    el("div", { class: "no-token" }, [
      el("h1", {}, ["Cairn"]),
      el("p", {}, ["This dashboard needs a session token, and only the CLI can hand it one."]),
      el("p", {}, ["Run this, then open the URL it prints:"]),
      el("pre", {}, [el("code", {}, ["cairn ui"])]),
      el("p", { class: "muted" }, ["That starts the daemon (if it is not already running) and opens this page with a fresh token."]),
    ]),
  );
}

function renderComingSoon(container: HTMLElement, label: string): void {
  clear(container);
  container.appendChild(
    el("div", { class: "state-panel" }, [
      el("p", {}, [`${label} is coming in the next step.`]),
      el("p", { class: "muted" }, ["This section is not implemented yet, but it will use the same store as Memories."]),
    ]),
  );
}

function renderHeaderStats(headerStats: HTMLElement, stats: StatsResult | null): void {
  clear(headerStats);
  if (!stats) {
    headerStats.appendChild(el("span", { class: "muted" }, ["Stats unavailable."]));
    return;
  }
  const items: Array<[string, number]> = [
    ["Live memories", stats.liveMemories],
    ["Scopes", stats.scopes.length],
    ["Episodes", stats.episodes],
    ["Redacted", stats.redactedMemories],
  ];
  for (const [label, value] of items) {
    headerStats.appendChild(
      el("div", { class: "stat" }, [el("span", { class: "stat-value" }, [String(value)]), el("span", { class: "stat-label" }, [label])]),
    );
  }
}

function renderApp(root: HTMLElement): void {
  clear(root);

  const nav = el(
    "nav",
    { class: "sidebar", "aria-label": "Dashboard sections" },
    SECTIONS.map((section) => {
      const link = el("a", { href: `#/${section.id}`, class: "nav-link" }, [section.label]);
      return el("div", {}, [link]);
    }),
  );

  const headerStats = el("div", { class: "header-stats" });
  const header = el("header", { class: "app-header" }, [el("div", { class: "brand" }, ["Cairn"]), headerStats]);

  const viewOutlet = el("main", { class: "view-outlet" });

  root.appendChild(el("div", { class: "app-shell" }, [nav, el("div", { class: "app-main" }, [header, viewOutlet])]));

  let unmountCurrentView: (() => void) | null = null;

  function setActiveLink(section: SectionId): void {
    for (const child of Array.from(nav.querySelectorAll("a.nav-link"))) {
      if (child.getAttribute("href") === `#/${section}`) {
        child.classList.add("active");
        child.setAttribute("aria-current", "page");
      } else {
        child.classList.remove("active");
        child.removeAttribute("aria-current");
      }
    }
  }

  function renderRoute(): void {
    unmountCurrentView?.();
    unmountCurrentView = null;
    const section = currentSection();
    setActiveLink(section);
    clear(viewOutlet);
    if (section === "memories") {
      unmountCurrentView = mountMemoriesView(viewOutlet);
    } else {
      renderComingSoon(viewOutlet, SECTIONS.find((s) => s.id === section)?.label ?? section);
    }
  }

  window.addEventListener("hashchange", renderRoute);
  renderRoute();

  void getStats()
    .then((stats) => renderHeaderStats(headerStats, stats))
    .catch(() => renderHeaderStats(headerStats, null));
}

function main(): void {
  bootstrapToken();
  const found = document.getElementById("app");
  if (!found) return;
  const root: HTMLElement = found;

  function showAuthGate(): void {
    renderNoToken(root);
  }

  setUnauthorizedHandler(() => {
    clearToken();
    showAuthGate();
  });

  if (!getToken()) {
    showAuthGate();
    return;
  }

  renderApp(root);
}

main();

export {};
