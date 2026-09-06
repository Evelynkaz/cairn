// Reproduces the published bug (`npx cairn-mem` / the npm .bin shim print
// nothing and exit 0): npm/npx always run a package's bin through a SYMLINK
// under node_modules/.bin, which sets process.argv[1] to the symlink path
// while import.meta.url resolves to the real file -- a naive comparison
// between them is always false, so main() never ran. Every test here spawns
// a real `node` process against the SYMLINK the way npm does, not the direct
// dist path the CI smoke job already covers, because that direct path never
// exercised this bug.

import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { withTempDirAsync } from "../testing/tmp.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(here, "index.js");

function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

test("--version through a .bin-style symlink prints the version", async () => {
  await withTempDirAsync(async (dir) => {
    const symlinkPath = join(dir, "cairn");
    symlinkSync(cliEntry, symlinkPath);
    const { stdout, code } = await runNode([symlinkPath, "--version"], {
      ...process.env,
      CAIRN_HOME: join(dir, "home"),
    });
    assert.equal(code, 0);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  });
});

test("status through a .bin-style symlink prints status, not silence", async () => {
  await withTempDirAsync(async (dir) => {
    const symlinkPath = join(dir, "cairn");
    symlinkSync(cliEntry, symlinkPath);
    const { stdout, code } = await runNode([symlinkPath, "status"], {
      ...process.env,
      CAIRN_HOME: join(dir, "home"),
    });
    assert.equal(code, 0);
    assert.notEqual(stdout.trim(), "");
  });
});

test("importing the module does not run main() (no stdout, guard still holds)", async () => {
  // Dynamic import() requires a file:// URL for a drive-letter path on
  // Windows -- a raw path throws ERR_UNSUPPORTED_ESM_URL_SCHEME there.
  const cliEntryUrl = pathToFileURL(cliEntry).href;
  const { stdout, stderr, code } = await runNode(
    ["--input-type=module", "-e", `import(${JSON.stringify(cliEntryUrl)});`],
    process.env,
  );
  assert.equal(code, 0);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});
