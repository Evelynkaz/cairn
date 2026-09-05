import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPackageFiles } from "./verify-package.js";

const BIN = "dist/cli/index.js";
const GOOD_FILES = [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/cli/index.js",
  "dist/daemon/main.js",
  "dist/dashboard/ui/index.html",
  "dist/dashboard/ui/app.js",
  "dist/dashboard/ui/styles.css",
];

test("checkPackageFiles accepts a well-formed file list", () => {
  assert.deepEqual(checkPackageFiles(GOOD_FILES, BIN), []);
});

test("checkPackageFiles flags a missing bin entry point", () => {
  const files = GOOD_FILES.filter((f) => f !== BIN);
  const problems = checkPackageFiles(files, BIN);
  assert.ok(problems.some((p) => p.includes(BIN)));
});

test("checkPackageFiles flags a missing dashboard asset", () => {
  const files = GOOD_FILES.filter((f) => f !== "dist/dashboard/ui/app.js");
  const problems = checkPackageFiles(files, BIN);
  assert.ok(problems.some((p) => p.includes("dist/dashboard/ui/app.js")));
});

test("checkPackageFiles flags a leaked test file", () => {
  const files = [...GOOD_FILES, "dist/daemon/main.test.js"];
  const problems = checkPackageFiles(files, BIN);
  assert.ok(problems.some((p) => p.includes("dist/daemon/main.test.js")));
});

test("checkPackageFiles flags a leaked src/ tree", () => {
  const files = [...GOOD_FILES, "src/daemon/main.ts"];
  const problems = checkPackageFiles(files, BIN);
  assert.ok(problems.some((p) => p.includes("src/daemon/main.ts")));
});
