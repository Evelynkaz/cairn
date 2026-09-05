// CI check: proves `npm pack` ships exactly what `npx cairn` needs and
// nothing else. Run after `npm run build` (see .github/workflows/ci.yml),
// next to "Verify sqlite-vec loadable extension" -- same idea, different
// failure mode: package.json's `files` field is an easy silent regression
// (no test would otherwise notice a missing dashboard or a leaked src/ tree).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// This compiled file lives at dist/scripts/verify-package.js, so the repo
// root is two levels up.
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const REQUIRED_DASHBOARD_FILES = [
  "dist/dashboard/ui/index.html",
  "dist/dashboard/ui/app.js",
  "dist/dashboard/ui/styles.css",
];

const TEST_ARTIFACT_RE = /\.test\.(js|d\.ts)(\.map)?$/;

// Pure predicate over a packed file list, kept separate from the npm-pack
// plumbing so it can be unit tested against constructed lists without
// actually shelling out (see verify-package.test.ts).
export function checkPackageFiles(paths: string[], binPath: string): string[] {
  const problems: string[] = [];
  const pathSet = new Set(paths);

  if (!pathSet.has(binPath)) {
    problems.push(`bin entry point missing: ${binPath}`);
  }

  for (const required of REQUIRED_DASHBOARD_FILES) {
    if (!pathSet.has(required)) {
      problems.push(`dashboard asset missing: ${required}`);
    }
  }

  const testArtifacts = paths.filter((p) => TEST_ARTIFACT_RE.test(p));
  if (testArtifacts.length > 0) {
    problems.push(`test artifact(s) present: ${testArtifacts.join(", ")}`);
  }

  const srcFiles = paths.filter((p) => p === "src" || p.startsWith("src/"));
  if (srcFiles.length > 0) {
    problems.push(`src/ present: ${srcFiles.join(", ")}`);
  }

  return problems;
}

function readBinPath(): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    bin?: string | Record<string, string>;
  };
  if (typeof pkg.bin === "string") {
    return pkg.bin;
  }
  if (pkg.bin && typeof pkg.bin === "object") {
    const values = Object.values(pkg.bin);
    if (values[0] !== undefined) {
      return values[0];
    }
  }
  throw new Error("verify-package: package.json has no bin entry to check against");
}

interface NpmPackEntry {
  files: { path: string }[];
}

// `execFileSync("npm", ...)` fails on Windows with `spawnSync npm ENOENT`,
// because there the executable on PATH is `npm.cmd`, not `npm` -- unlike a
// shell, execFile does not consult PATHEXT to resolve a bare name. Prefer
// `npm_execpath`, which npm sets to its own JS entrypoint when it invokes a
// script; running that through `process.execPath` sidesteps executable
// name resolution (and any shell) entirely. Fall back to a platform-picked
// binary name when npm_execpath isn't set, e.g. when this script is run
// directly with `node`, as CI does.
export function resolveNpmCommand(
  platform: NodeJS.Platform,
  npmExecPath: string | undefined,
  execPath: string,
): { command: string; args: string[] } {
  if (npmExecPath) {
    return { command: execPath, args: [npmExecPath] };
  }
  return { command: platform === "win32" ? "npm.cmd" : "npm", args: [] };
}

export function packedFiles(): string[] {
  const { command, args } = resolveNpmCommand(process.platform, process.env.npm_execpath, process.execPath);
  const output = execFileSync(command, [...args, "pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const parsed = JSON.parse(output) as NpmPackEntry[];
  const entry = parsed[0];
  if (!entry) {
    throw new Error("verify-package: npm pack --dry-run --json returned no entries");
  }
  // `npm pack --dry-run --json` reports `files[].path` with forward
  // slashes on every platform (npm normalizes internally), but normalize
  // any stray backslash here too so the checks below never depend on it.
  return entry.files.map((f) => f.path.replace(/\\/g, "/"));
}

function main(): void {
  const binPath = readBinPath();
  console.log(`verify-package: checking bin entry ${binPath}`);
  console.log(`verify-package: checking dashboard assets ${REQUIRED_DASHBOARD_FILES.join(", ")}`);
  console.log("verify-package: checking for test artifacts and a leaked src/ tree");

  const paths = packedFiles();
  console.log(`verify-package: npm pack would ship ${paths.length} file(s)`);

  const problems = checkPackageFiles(paths, binPath);
  if (problems.length > 0) {
    throw new Error(`verify-package: package is wrong:\n  ${problems.join("\n  ")}`);
  }

  console.log("verify-package: package contents OK");
}

// Guarded so verify-package.test.ts can import checkPackageFiles without
// this script's side effects (shelling out to npm, process.exit) running on
// import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
