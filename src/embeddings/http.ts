// HTTP embedding providers: ollama (local server, no key) and the two
// opt-in "max quality" hosted APIs, openai and voyage (BUILD_BRIEF §3). The
// product is fully functional with none of these configured -- they are an
// override, never the default (see factory.ts, which never selects one
// without explicit configuration).

import type { EmbeddingProvider, ProviderName } from "./types.js";
import { assertEmbeddingShape, normalize } from "./types.js";

export interface HttpProviderOptions {
  name: "ollama" | "openai" | "voyage";
  modelId?: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  /** Request timeout in ms. Defaults to 30s; overridable so tests can exercise it fast. */
  timeoutMs?: number;
}

const DEFAULTS: Record<"ollama" | "openai" | "voyage", { baseUrl: string; modelId: string }> = {
  ollama: { baseUrl: "http://127.0.0.1:11434", modelId: "nomic-embed-text" },
  openai: { baseUrl: "https://api.openai.com", modelId: "text-embedding-3-small" },
  voyage: { baseUrl: "https://api.voyageai.com", modelId: "voyage-3-lite" },
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_EXCERPT_CHARS = 200;

// Dimensions of the default models above, verified against each provider's
// published docs. Trusted without a network round trip so the common,
// default-model path constructs with zero extra requests -- the first real
// embed() call still checks the response against this value (via
// assertEmbeddingShape below), so a model silently swapped behind the same
// name fails loudly instead of writing mismatched vectors into an existing
// space.
const KNOWN_MODEL_DIMS: Record<string, number> = {
  "nomic-embed-text": 768,
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "voyage-3-lite": 512,
};

// Used only to discover the dimension of a model this module does not
// already know, by embedding it once at construction time (see
// createHttpProvider). Content is irrelevant -- only the returned vector's
// length is read.
const DIM_PROBE_TEXT = "cairn embedding dimension probe";

// BUILD_BRIEF §10: API keys never touch the database and never appear in an
// error, a log line, or anywhere else -- they are read from the environment
// at use time, every time, and nowhere else.
function requireApiKey(name: "openai" | "voyage", env: NodeJS.ProcessEnv): string {
  const envVar = name === "openai" ? "OPENAI_API_KEY" : "VOYAGE_API_KEY";
  const key = env[envVar];
  if (!key) {
    throw new Error(`embedding provider "${name}" requires the ${envVar} environment variable to be set`);
  }
  return key;
}

// BUILD_BRIEF §10: an error body is untrusted third-party text -- a gateway
// that echoes request context (e.g. LiteLLM debug responses, some proxies)
// can include the Authorization header or key back in it. Redact before
// slicing, not after, so a key never has a chance to survive truncation.
function redactSecrets(text: string, apiKey: string | undefined): string {
  let redacted = apiKey ? text.split(apiKey).join("[redacted]") : text;
  redacted = redacted.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  redacted = redacted.replace(/\b(sk|voy)-[A-Za-z0-9_-]{8,}/g, "[redacted]");
  return redacted;
}

async function readBodyExcerpt(response: Response, apiKey?: string): Promise<string> {
  try {
    const text = await response.text();
    return redactSecrets(text, apiKey).slice(0, MAX_BODY_EXCERPT_CHARS);
  } catch {
    return "";
  }
}

interface OllamaResponse {
  embeddings?: number[][];
}

interface OpenAiCompatibleItem {
  index?: number;
  embedding?: number[];
}

interface OpenAiCompatibleResponse {
  data?: OpenAiCompatibleItem[];
}

async function callOllama(
  baseUrl: string,
  modelId: string,
  texts: string[],
  signal: AbortSignal,
): Promise<Float32Array[]> {
  const response = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: modelId, input: texts }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`ollama embedding request failed: ${response.status} ${await readBodyExcerpt(response)}`);
  }
  const json = (await response.json()) as OllamaResponse;
  const embeddings = json.embeddings ?? [];
  return embeddings.map((row) => Float32Array.from(row));
}

// Shared by openai and voyage: both expose the same request/response shape
// at /v1/embeddings. The response's `index` field is authoritative for
// ordering -- the contract requires vectors back in input order, and a
// provider that silently reorders them would mis-map memories to vectors
// with no error anywhere, so array order is never trusted here.
async function callOpenAiCompatible(
  providerName: "openai" | "voyage",
  baseUrl: string,
  modelId: string,
  apiKey: string,
  texts: string[],
  signal: AbortSignal,
): Promise<Float32Array[]> {
  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: modelId, input: texts }),
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `${providerName} embedding request failed: ${response.status} ${await readBodyExcerpt(response, apiKey)}`,
    );
  }
  const json = (await response.json()) as OpenAiCompatibleResponse;
  const items = json.data ?? [];
  const ordered = [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return ordered.map((item) => Float32Array.from(item.embedding ?? []));
}

async function callProvider(
  providerName: "ollama" | "openai" | "voyage",
  baseUrl: string,
  modelId: string,
  env: NodeJS.ProcessEnv,
  texts: string[],
  timeoutMs: number,
): Promise<Float32Array[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  if (providerName === "ollama") {
    return callOllama(baseUrl, modelId, texts, signal);
  }
  const apiKey = requireApiKey(providerName, env);
  return callOpenAiCompatible(providerName, baseUrl, modelId, apiKey, texts, signal);
}

// Async precisely so `dim` (see invariant 3 in types.ts) is real and
// positive before anyone can observe it: a hosted model's dimension is not
// knowable without a network round trip, so construction either looks it up
// (known default models, no request) or probes it once (any other model)
// before this promise resolves. Never resolves with `dim: 0`.
export async function createHttpProvider(options: HttpProviderOptions): Promise<EmbeddingProvider> {
  const env = options.env ?? process.env;
  const name: ProviderName = options.name;
  const defaults = DEFAULTS[options.name];
  const baseUrl = (options.baseUrl ?? defaults.baseUrl).replace(/\/$/, "");
  const modelId = options.modelId ?? defaults.modelId;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let closed = false;

  const knownDim = KNOWN_MODEL_DIMS[modelId];
  let dim: number;
  if (knownDim !== undefined) {
    dim = knownDim;
  } else {
    const probeVectors = await callProvider(options.name, baseUrl, modelId, env, [DIM_PROBE_TEXT], timeoutMs);
    const probed = probeVectors[0]?.length ?? 0;
    if (probed <= 0) {
      throw new Error(
        `embedding provider "${name}" (model "${modelId}") returned an empty vector while probing its dimension`,
      );
    }
    dim = probed;
  }

  async function embed(texts: string[]): Promise<Float32Array[]> {
    if (closed) {
      throw new Error(`http provider "${name}" was used after close()`);
    }
    const raw = await callProvider(options.name, baseUrl, modelId, env, texts, timeoutMs);
    const normalized = raw.map((v) => normalize(v));
    // Guards against a model silently swapped behind the same name/endpoint
    // after this provider was constructed: `dim` is fixed (invariant 3 in
    // types.ts), so a response of a different length must fail loudly here
    // rather than write a mismatched vector into an existing space.
    assertEmbeddingShape(normalized, texts, dim, name);
    return normalized;
  }

  return {
    // Namespaced by provider name so that an ollama-compatible backend and
    // the real OpenAI API serving the same model name (e.g.
    // "text-embedding-3-small") never share a vector space -- see the
    // `modelId` contract in types.ts. The bare `modelId` above (without the
    // namespace) is what actually goes in the request body, since that's
    // what the API expects.
    modelId: `${name}:${modelId}`,
    dim,
    name,
    // These are the opt-in "max quality" override of §3: every one of
    // ollama/openai/voyage performs a network request on every embed()
    // call, and the product is fully functional with none of them
    // configured (factory.ts never selects one by default).
    requiresNetwork: true,
    embed,
    async close(): Promise<void> {
      closed = true;
    },
  };
}
