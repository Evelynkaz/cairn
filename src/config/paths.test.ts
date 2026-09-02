import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { dbPath, ensureHome, resolveCairnHome } from "./paths.js";

function uniqueTempDir(): string {
  return join(tmpdir(), `cairn-test-${randomBytes(8).toString("hex")}`);
}

test("CAIRN_HOME override wins and is absolutised", () => {
  const home = resolveCairnHome({ CAIRN_HOME: "relative/path" });
  assert.equal(home, resolve("relative/path"));
});

test("empty or whitespace-only CAIRN_HOME falls back to the default home", () => {
  assert.equal(resolveCairnHome({ CAIRN_HOME: "" }), join(homedir(), ".cairn"));
  assert.equal(resolveCairnHome({ CAIRN_HOME: "   " }), join(homedir(), ".cairn"));
});

test("default home sits under os.homedir()", () => {
  const home = resolveCairnHome({});
  assert.ok(home.startsWith(homedir()));
  assert.ok(home.endsWith(".cairn"));
});

test("dbPath ends with cairn.db", () => {
  assert.ok(dbPath("/some/dir").endsWith("cairn.db"));
});

test("ensureHome creates the directory and is idempotent", () => {
  const dir = uniqueTempDir();
  try {
    assert.ok(!existsSync(dir));
    const result = ensureHome(dir);
    assert.equal(result, dir);
    assert.ok(existsSync(dir));
    assert.doesNotThrow(() => ensureHome(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
