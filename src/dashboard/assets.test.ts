// Exercises serveUiFile against the real built dist/dashboard/ui directory
// (proving the copy-ui-assets build step actually produced it), plus a
// synthetic temp fixture for the sibling-directory prefix-check bug that
// the real build has no reason to reproduce on its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { serveUiFile, uiRoot } from "./assets.js";
import { withTempDir } from "../testing/tmp.js";

test("/ui and /ui/ both serve index.html", () => {
  const withoutSlash = serveUiFile("/ui");
  const withSlash = serveUiFile("/ui/");
  assert.equal(withoutSlash.status, 200);
  assert.equal(withSlash.status, 200);
  assert.equal(withoutSlash.headers["content-type"], "text/html; charset=utf-8");
  assert.ok(withoutSlash.body.toString("utf8").includes("<div id=\"app\">"));
  assert.deepEqual(withoutSlash.body, withSlash.body);
});

test("styles.css and app.js are served with the right content types", () => {
  const css = serveUiFile("/ui/styles.css");
  assert.equal(css.status, 200);
  assert.equal(css.headers["content-type"], "text/css; charset=utf-8");

  const js = serveUiFile("/ui/app.js");
  assert.equal(js.status, 200);
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
});

test("an unknown file is 404", () => {
  const res = serveUiFile("/ui/nope.txt");
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.body.toString("utf8")), { error: "not found" });
});

test("a literal ../.. traversal is 403", () => {
  const res = serveUiFile("/ui/../../package.json");
  assert.equal(res.status, 403);
  assert.ok(!res.body.toString("utf8").includes("package.json"));
});

test("a percent-encoded traversal is 403", () => {
  const res = serveUiFile("/ui/%2e%2e%2f%2e%2e%2fpackage.json");
  assert.equal(res.status, 403);
});

test("a path containing a NUL byte is 403", () => {
  const res = serveUiFile("/ui/app.js" + "\0" + ".html");
  assert.equal(res.status, 403);
});

test("the html response carries the CSP header and nosniff", () => {
  const res = serveUiFile("/ui");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.ok(res.headers["content-security-policy"]?.includes("default-src 'self'"));
  assert.ok(res.headers["content-security-policy"]?.includes("script-src 'self'"));
});

test("a sibling directory named like <root>-evil is not served (separator-less prefix bug)", () => {
  withTempDir((dir) => {
    const root = join(dir, "ui");
    const evilSibling = join(dir, "ui-evil");
    mkdirSync(root, { recursive: true });
    mkdirSync(evilSibling, { recursive: true });
    writeFileSync(join(evilSibling, "secret.html"), "<p>secret</p>");

    const res = serveUiFile("/ui/../ui-evil/secret.html", root);
    assert.equal(res.status, 403);
  });
});

test("the served index.html references its assets by root-absolute /ui paths, not document-relative ones", () => {
  const res = serveUiFile("/ui");
  const html = res.body.toString("utf8");
  assert.ok(html.includes("/ui/styles.css"));
  assert.ok(html.includes("/ui/app.js"));
  assert.ok(!html.includes('"./styles.css"'));
  assert.ok(!html.includes('"./app.js"'));
});

test("a symlink inside root pointing outside it is not served (symlink escape)", (t) => {
  withTempDir((dir) => {
    const root = join(dir, "ui");
    const secretDir = join(dir, "secret");
    mkdirSync(root, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    const secretFile = join(secretDir, "leak.html");
    writeFileSync(secretFile, "<p>secret</p>");

    const link = join(root, "leak.html");
    try {
      symlinkSync(secretFile, link);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "ENOSYS") {
        t.skip("creating a symlink requires privilege on this platform");
        return;
      }
      throw error;
    }

    const res = serveUiFile("/ui/leak.html", root);
    assert.equal(res.status, 403);
    assert.ok(!res.body.toString("utf8").includes("secret"));
  });
});

test("uiRoot() points at the real built dashboard directory", () => {
  const root = uiRoot();
  assert.ok(root.endsWith(join("dashboard", "ui")));
});
