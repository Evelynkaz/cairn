import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, rmSync, statSync } from "node:fs";
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

test("ensureHome tightens a group/other-readable home on POSIX", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX file mode bits are not meaningful on Windows");
    return;
  }
  if (process.getuid?.() === 0) {
    t.skip("chmod bits are not enforced against the owning root user");
    return;
  }
  const dir = uniqueTempDir();
  try {
    ensureHome(dir);
    chmodSync(dir, 0o755);
    ensureHome(dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureHome skips the mode check entirely on Windows, where the bits are meaningless", (t) => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  const originalWrite = process.stderr.write.bind(process.stderr);
  let wrote = false;
  process.stderr.write = ((...args: Parameters<typeof originalWrite>) => {
    wrote = true;
    return originalWrite(...args);
  }) as typeof process.stderr.write;

  const dir = uniqueTempDir();
  try {
    ensureHome(dir);
    ensureHome(dir);
    assert.equal(wrote, false, "ensureHome must not warn on Windows");
  } finally {
    process.stderr.write = originalWrite;
    Object.defineProperty(process, "platform", { value: originalPlatform });
    rmSync(dir, { recursive: true, force: true });
  }
});
