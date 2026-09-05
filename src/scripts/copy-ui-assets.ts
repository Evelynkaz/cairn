// Build step run AFTER `tsc` (see package.json "build"): copies every
// non-`.ts` file under src/dashboard/ui/ into dist/dashboard/ui/, since tsc
// only emits .js/.d.ts/.map and never touches html/css/other static assets.
// Resolves paths from import.meta.url, not process.cwd(), because npm test
// and CI do not guarantee the working directory this script runs from.

import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

// This compiled file lives at dist/scripts/copy-ui-assets.js, so the repo
// root is two levels up.
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const srcUiDir = join(repoRoot, "src", "dashboard", "ui");
const destUiDir = join(repoRoot, "dist", "dashboard", "ui");

function copyDir(src: string, dest: string, copied: Set<string>): number {
  mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      count += copyDir(srcPath, destPath, copied);
    } else if (extname(entry) !== ".ts") {
      copyFileSync(srcPath, destPath);
      copied.add(destPath);
      count += 1;
    }
  }
  return count;
}

// tsc runs before this script (see package.json "build") and emits .js/.map
// and .d.ts files for src/dashboard/ui/*.ts straight into destUiDir; pruning
// must never touch those, only the files this script itself is responsible
// for -- otherwise it would delete tsc's own just-written output.
const TSC_OWNED_EXTENSIONS = new Set([".js", ".map", ".ts"]);

// Makes dist a true mirror of the non-.ts assets under src, not an
// accumulating pile: without this, a renamed or deleted asset survives in
// dist forever, and serveUiFile keeps serving a file that no longer exists
// in source.
function pruneStale(dest: string, copied: Set<string>): void {
  if (!existsSync(dest)) {
    return;
  }
  for (const entry of readdirSync(dest)) {
    const destPath = join(dest, entry);
    if (statSync(destPath).isDirectory()) {
      pruneStale(destPath, copied);
      continue;
    }
    if (TSC_OWNED_EXTENSIONS.has(extname(destPath)) || copied.has(destPath)) {
      continue;
    }
    rmSync(destPath, { force: true });
  }
}

function main(): void {
  if (!existsSync(srcUiDir)) {
    throw new Error(`copy-ui-assets: source directory not found: ${srcUiDir}`);
  }
  const copied = new Set<string>();
  const count = copyDir(srcUiDir, destUiDir, copied);
  pruneStale(destUiDir, copied);
  console.log(`copy-ui-assets: copied ${count} file(s) to ${destUiDir}`);
}

try {
  main();
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
