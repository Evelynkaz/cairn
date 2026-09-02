import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createProviderFromConfig, explainUnavailable } from "./factory.js";
import type { EmbeddingConfig } from "./registry.js";
import { makeTempDir } from "../testing/tmp.js";

function config(patch: Partial<EmbeddingConfig>): EmbeddingConfig {
  return { provider: "off", modelId: null, consented: false, source: "default", ...patch };
}

// Not a string literal on purpose, for the same reason local-onnx.ts routes
// its own runtime import through a variable: a literal specifier makes
// TypeScript attempt to statically resolve it, which fails to compile when
// the (optional peer) package is not installed.
const RUNTIME_SPECIFIER = "@huggingface/transformers";

// True only on a machine where the optional peer has actually been
// installed. The local-provider test below assumes resolution genuinely
// fails; asserting that explicitly, and skipping otherwise, keeps it from
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

// createLocalProvider (via createProviderFromConfig) reads process.env
// directly rather than an injectable env, so CAIRN_HOME is pointed at a
// fresh, empty temp directory for the duration of `fn` and restored
// afterwards, so this never touches (or downloads a model into) the
// developer's real ~/.cairn.
async function withTempCairnHome<T>(fn: () => Promise<T>): Promise<T> {
  const dir = makeTempDir();
  const originalHome = process.env.CAIRN_HOME;
  process.env.CAIRN_HOME = dir;
  try {
    return await fn();
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

test("provider off resolves to null", async () => {
  const provider = await createProviderFromConfig(config({ provider: "off" }));
  assert.equal(provider, null);
  assert.equal(explainUnavailable(config({ provider: "off" })), null);
});

test("local provider without consent resolves to null and explains why", async () => {
  const cfg = config({ provider: "local-onnx", consented: false });
  const provider = await createProviderFromConfig(cfg);
  assert.equal(provider, null);
  const explanation = explainUnavailable(cfg);
  assert.ok(explanation);
  assert.match(explanation, /consent/i);
  assert.match(explanation, /local-onnx/);
});

// Consented + local is a different "unavailable" reason than "not
// consented" -- it must not silently return null too, or the CLI/dashboard
// could never tell "waiting on you" apart from "runtime genuinely missing".
// The real @huggingface/transformers runtime is not installed in this
// project (see local-onnx.ts), so this exercises the real missing-runtime
// path.
test("local provider with consent attempts the local provider and surfaces its error, not null", async (t) => {
  if (await transformersResolves()) {
    t.skip("@huggingface/transformers resolves on this machine; skipping to avoid a real model download");
    return;
  }
  const cfg = config({ provider: "local-onnx", consented: true });
  await withTempCairnHome(async () => {
    await assert.rejects(createProviderFromConfig(cfg), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /cairn embeddings enable/);
      return true;
    });
  });
  assert.equal(explainUnavailable(cfg), null);
});

test("an http provider is only created when explicitly configured, never by default", async () => {
  const offProvider = await createProviderFromConfig(config({ provider: "off" }));
  assert.equal(offProvider, null);

  const ollamaProvider = await createProviderFromConfig(
    config({ provider: "ollama" }),
    { PATH: process.env.PATH ?? "" },
  );
  assert.ok(ollamaProvider);
  assert.equal(ollamaProvider.name, "ollama");
  assert.equal(ollamaProvider.requiresNetwork, true);
  await ollamaProvider.close();
});
