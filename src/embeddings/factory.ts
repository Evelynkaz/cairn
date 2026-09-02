// Wires an EmbeddingConfig (registry.ts) to a concrete provider. "off" and
// "not yet consented" are both supported, non-error outcomes -- BUILD_BRIEF
// §2 makes FTS-only a real mode and forbids downloading a model without
// consent -- so both return `null` rather than throwing.

import type { EmbeddingConfig } from "./registry.js";
import type { EmbeddingProvider, ProviderName } from "./types.js";
import { createLocalProvider } from "./local-onnx.js";
import { createHttpProvider } from "./http.js";

function isLocalProviderName(name: ProviderName): name is "local-onnx" | "local-static" {
  return name === "local-onnx" || name === "local-static";
}

function isHttpProviderName(name: ProviderName): name is "ollama" | "openai" | "voyage" {
  return name === "ollama" || name === "openai" || name === "voyage";
}

// Tells the CLI/dashboard why semantic search is currently unavailable, in
// plain language, without requiring them to duplicate this module's
// decision logic. Returns null when there is nothing to explain (off, or
// consented and dispatched to a provider that may or may not itself throw).
export function explainUnavailable(config: EmbeddingConfig): string | null {
  if (config.provider === "off") {
    return null;
  }
  if (isLocalProviderName(config.provider) && !config.consented) {
    return (
      `Semantic search via "${config.provider}" is configured but not enabled yet: it needs a one-time ` +
      `model download, and Cairn never downloads a model without your consent. Run: cairn embeddings enable.`
    );
  }
  return null;
}

export async function createProviderFromConfig(
  config: EmbeddingConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EmbeddingProvider | null> {
  if (config.provider === "off") {
    return null;
  }
  if (isLocalProviderName(config.provider)) {
    if (!config.consented) {
      return null;
    }
    return createLocalProvider({
      name: config.provider,
      modelId: config.modelId ?? undefined,
    });
  }
  if (isHttpProviderName(config.provider)) {
    return await createHttpProvider({
      name: config.provider,
      modelId: config.modelId ?? undefined,
      env,
    });
  }
  throw new Error(`embedding provider "${config.provider}" is not resolvable to a provider implementation`);
}
