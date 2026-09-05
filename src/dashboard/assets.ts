// Safe static file server for the built dashboard UI (dist/dashboard/ui).
// Path traversal is the security-relevant part of this module: everything
// here exists to make sure a request can never read a file outside `root`.

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve, join, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";

// This compiled file lives at dist/dashboard/assets.js, so dist/dashboard/ui
// is a direct sibling.
export function uiRoot(): string {
  return join(resolve(fileURLToPath(import.meta.url), ".."), "ui");
}

export interface ServeResult {
  status: number;
  headers: Record<string, string>;
  /** File contents, or a short JSON/text error body. */
  body: Buffer;
}

// Allowlist, not a lookup table with an octet-stream fallback: a stray file
// of an unrecognized type in the ui directory must never be servable as
// something a browser will execute unexpectedly.
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

// The dashboard is served from the user's own daemon, not a CDN -- a stale
// cached build is a support problem, so never let the browser cache it.
const COMMON_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

// Blocks any network calls the SPA's markup could otherwise make off the
// machine (BUILD_BRIEF §2's "no network calls in the default path",
// enforced in the browser too), and forbids inline scripts/styles -- so the
// SPA must keep its JS and CSS in separate files.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function notFound(): ServeResult {
  return {
    status: 404,
    headers: { "content-type": "application/json; charset=utf-8", ...COMMON_HEADERS },
    body: Buffer.from(JSON.stringify({ error: "not found" })),
  };
}

function forbidden(): ServeResult {
  // Never echo the requested path back in the body.
  return {
    status: 403,
    headers: { "content-type": "application/json; charset=utf-8", ...COMMON_HEADERS },
    body: Buffer.from(JSON.stringify({ error: "forbidden" })),
  };
}

/**
 * Resolves `pathname` (the full request path, e.g. "/ui" or "/ui/app.js") to a
 * built UI file. "/ui" and "/ui/" both resolve to index.html.
 */
export function serveUiFile(pathname: string, root: string = uiRoot()): ServeResult {
  if (pathname.includes("\0")) {
    return forbidden();
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return forbidden();
  }
  if (decoded.includes("\0")) {
    return forbidden();
  }

  let relative = decoded.replace(/^\/ui\/?/, "");
  if (relative === "") {
    relative = "index.html";
  }

  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, relative);
  // Prefix check WITH the separator: a bare startsWith(resolvedRoot) would
  // let a sibling directory like "<root>-evil" pass.
  if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + sep)) {
    return forbidden();
  }

  const ext = extname(candidate);
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    return notFound();
  }

  // realpathSync(root) itself, not just the candidate: on macOS a temp dir
  // is typically /var/... symlinked to /private/var/..., so realpathing
  // only the candidate would make a legitimate file appear outside its own
  // root and 403 every request in the temp-dir tests. A missing root
  // (thrown by realpathSync) is a 404, not an exception escaping this
  // function -- serveUiFile's contract is that it never throws.
  let realRoot: string;
  try {
    realRoot = realpathSync(resolvedRoot);
  } catch {
    return notFound();
  }

  let body: Buffer;
  try {
    if (!existsSync(candidate)) {
      return notFound();
    }
    // The lexical check above is the cheap first gate (it is what makes
    // "/ui/../../package.json" a 403 rather than a 404); resolve() does not
    // follow symlinks, though, so a symlink inside root pointing outside it
    // would otherwise slip through that check and get read here.
    const real = realpathSync(candidate);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      return forbidden();
    }
    body = readFileSync(real);
  } catch {
    // An unexpected read error is a 404, never a 500 carrying a filesystem path.
    return notFound();
  }

  const headers: Record<string, string> = { "content-type": contentType, ...COMMON_HEADERS };
  if (ext === ".html") {
    headers["content-security-policy"] = CSP;
  }

  return { status: 200, headers, body };
}
