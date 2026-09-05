// Session-scoped auth token. Kept separate from api-client.ts so app.ts
// (which needs the token just to decide whether to render the app at all)
// does not have to import the whole network layer to read it.
//
// sessionStorage, not localStorage: the token is a fresh grant handed out
// by `cairn ui` each time (src/cli/lifecycle.ts's uiUrl()), and it should
// not silently outlive the tab.

const TOKEN_KEY = "cairn.dashboard.token";

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}
