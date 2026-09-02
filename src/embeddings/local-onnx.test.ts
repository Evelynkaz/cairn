import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createLocalProvider, resolveCacheDir, pickEntry } from "./local-onnx.js";
import { makeTempDir } from "../testing/tmp.js";

// Not a string literal on purpose, for the same reason local-onnx.ts routes
// its own runtime import through a variable: a literal specifier makes
// TypeScript attempt to statically resolve it, which fails to compile when
// the (optional peer) package is not installed.
const RUNTIME_SPECIFIER = "@huggingface/transformers";

// True only on a machine where the optional peer has actually been
// installed (e.g. a contributor who ran `cairn embeddings enable`, or a
// carried-over CAIRN_HOME). The tests below assume resolution genuinely
// fails; asserting that explicitly, and skipping otherwise, keeps them from
// silently loading a real pipeline and downloading a model into a real
// CAIRN_HOME when that assumption stops holding.
async function transformersResolves(): Promise<boolean> {
  try {
    await import(RUNTIME_SPECIFIER);
    return true;
  } catch {
    return false;
  }
}

// Not `withTempDir` from testing/tmp.ts: that helper's cleanup runs
// synchronously right after invoking `fn`, which would delete the temp
// directory before an async `fn`'s awaited body has actually run. This
// awaits `fn` before cleaning up, and always points CAIRN_HOME at the fresh
// directory for the duration -- restoring it afterwards -- so these tests
// never touch (or download a model into) the developer's real ~/.cairn.
async function withTempCairnHome<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = makeTempDir();
  const originalHome = process.env.CAIRN_HOME;
  process.env.CAIRN_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (originalHome === undefined) {
      delete process.env.CAIRN_HOME;
    } else {
      process.env.CAIRN_HOME = originalHome;
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Best-effort: never mask the real failure from fn() with a cleanup error.
    }
  }
}

// The real @huggingface/transformers runtime is never installed in this
// project or in CI (see local-onnx.ts header comment), so resolution
// genuinely fails here -- this exercises the real "not installed" path,
// not a mock of it.
test("missing runtime produces an actionable, non-broken error", async (t) => {
  if (await transformersResolves()) {
    t.skip("@huggingface/transformers resolves on this machine; skipping to avoid a real model download");
    return;
  }
  await withTempCairnHome(async () => {
    await assert.rejects(
      createLocalProvider({ name: "local-onnx" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /cairn embeddings enable/);
        assert.match(error.message, /npm install --prefix/);
        assert.match(error.message, /@huggingface\/transformers/);
        assert.match(error.message, /keeps working with keyword search/);
        return true;
      },
    );
  });
});

// A package genuinely present at CAIRN_HOME but that fails to load (a
// corrupt install, an arch-mismatched native binding) must be reported
// differently from "not installed" -- the same install command would just
// fail again. This is hermetic: the "package" is a fake package.json
// pointing at a JS file that does not exist, so no real runtime is ever
// touched.
test("an installed-but-broken runtime reports a distinct error, not 'not installed'", async (t) => {
  if (await transformersResolves()) {
    t.skip("@huggingface/transformers resolves on this machine; skipping to avoid a real model download");
    return;
  }
  await withTempCairnHome(async (dir) => {
    const packageDir = join(dir, "node_modules", "@huggingface", "transformers");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ main: "index.js" }));
    await assert.rejects(
      createLocalProvider({ name: "local-onnx" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /found at/);
        assert.match(error.message, /failed to load/);
        assert.doesNotMatch(error.message, /cairn embeddings enable/);
        assert.ok(error.cause, "the original load error must be attached as cause");
        return true;
      },
    );
  });
});

test("cache directory resolves under CAIRN_HOME by default", () => {
  const dir = resolveCacheDir(undefined, { CAIRN_HOME: "C:\\fake\\home" });
  assert.equal(dir, join("C:\\fake\\home", "models"));
});

test("cache directory override wins over CAIRN_HOME", () => {
  const dir = resolveCacheDir("C:\\custom\\cache", { CAIRN_HOME: "C:\\fake\\home" });
  assert.equal(dir, "C:\\custom\\cache");
});

// The exact shape @huggingface/transformers publishes: no top-level
// "import" key under exports["."], only a nested "node" condition. A
// resolver that only checks the top-level "import" key falls through to
// pkg.module, which for this package is the browser build.
test("pickEntry selects the Node ESM entry for the published @huggingface/transformers exports shape", () => {
  const pkg = {
    module: "./dist/transformers.js",
    main: "./dist/transformers.js",
    exports: {
      ".": {
        types: "./types/transformers.d.ts",
        node: {
          import: "./dist/transformers.mjs",
          require: "./dist/transformers.cjs",
        },
        default: "./dist/transformers.js",
      },
    },
  };
  assert.equal(pickEntry(pkg), "./dist/transformers.mjs");
});

// This is the one place in the project where skipping a test is correct:
// loading a real model downloads ~100MB+ and requires network access, which
// would make CI flaky, slow, and non-hermetic across all three platforms.
// It only runs when a developer explicitly opts in locally or in a
// dedicated, non-default CI job.
test("real model load and embed (only with CAIRN_TEST_MODELS=1)", async (t) => {
  if (process.env.CAIRN_TEST_MODELS !== "1") {
    t.skip("set CAIRN_TEST_MODELS=1 to run this test; it downloads a real model and needs network access");
    return;
  }
  const provider = await createLocalProvider({ name: "local-onnx" });
  try {
    assert.equal(provider.dim, 384);
    const [vector] = await provider.embed(["hello world"]);
    assert.ok(vector);
    assert.equal(vector.length, 384);
  } finally {
    await provider.close();
  }
});
