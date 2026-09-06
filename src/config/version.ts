// Single source of truth for the installed version (BUILD_BRIEF: one place
// to read it, not a hardcoded constant that drifts from package.json on
// every release). Both the CLI's `--version` and the daemon's `/health` +
// runtime file import this instead of keeping their own copy.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
