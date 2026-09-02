// Deterministic, offline, dependency-free EmbeddingProvider used by every
// test in this project. It is a hash, not a model -- it captures nothing
// about meaning, only exact text identity -- but that is enough to exercise
// retrieval plumbing (hybrid RRF fusion, MMR, batching, cancellation) without
// ever downloading a model or touching the network. See ProviderName in
// types.ts for why "fake" is excluded from real configuration resolution.

import { createHash } from "node:crypto";
import type { EmbeddingProvider, ProviderName } from "./types.js";
import { assertEmbeddingShape, normalize } from "./types.js";

const DEFAULT_DIM = 32;
const DEFAULT_MODEL_ID = "fake-hash-v1";
const NAME: ProviderName = "fake";

export interface FakeProviderOptions {
  dim?: number;
  modelId?: string;
  /** Delays each embed() call, so batching and cancellation can be tested. */
  latencyMs?: number;
  /** embed() rejects if any text in the batch matches this predicate. */
  failOn?: (text: string) => boolean;
  /** Fires the moment embed() is entered, before the latencyMs delay (if
      any) is awaited. Lets a test perform work deterministically WHILE
      embed() is suspended, instead of racing a fixed sleep() against
      latencyMs -- see worker.test.ts's liveness-during-inference test. */
  onEmbedStart?: () => void | Promise<void>;
}

export interface FakeEmbeddingProvider extends EmbeddingProvider {
  /** Number of embed() invocations made so far. */
  readonly calls: number;
  /** Total number of texts embedded across all embed() calls. */
  readonly textsEmbedded: number;
}

// Derives a vector from SHA-256(text): the digest is expanded to `dim`
// floats by reading successive 4-byte big-endian chunks as unsigned 32-bit
// integers and mapping each into [-1, 1]; if `dim` needs more bytes than one
// digest provides, further digests of `text` salted with an incrementing
// counter are appended. The whole text is hashed (never just a prefix), so
// two texts that share a long prefix but differ later do not collapse onto
// near-identical vectors. The result is L2-normalised before it is
// returned, per the EmbeddingProvider contract.
function hashToVector(text: string, dim: number): Float32Array {
  const out = new Float32Array(dim);
  let counter = 0;
  let block = createHash("sha256").update(text).digest();
  let offset = 0;
  for (let i = 0; i < dim; i++) {
    if (offset + 4 > block.length) {
      counter += 1;
      block = createHash("sha256").update(text).update(String(counter)).digest();
      offset = 0;
    }
    const uint32 = block.readUInt32BE(offset);
    offset += 4;
    out[i] = (uint32 / 0xffffffff) * 2 - 1;
  }
  return normalize(out);
}

export function createFakeProvider(options: FakeProviderOptions = {}): FakeEmbeddingProvider {
  const dim = options.dim ?? DEFAULT_DIM;
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;
  const latencyMs = options.latencyMs ?? 0;
  const failOn = options.failOn;
  const onEmbedStart = options.onEmbedStart;
  let calls = 0;
  let textsEmbedded = 0;
  let closed = false;

  return {
    modelId,
    dim,
    name: NAME,
    requiresNetwork: false,

    get calls(): number {
      return calls;
    },
    get textsEmbedded(): number {
      return textsEmbedded;
    },

    async embed(texts: string[]): Promise<Float32Array[]> {
      if (closed) {
        throw new Error(`fake provider "${modelId}" was used after close()`);
      }
      calls += 1;
      await onEmbedStart?.();
      if (latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, latencyMs));
      }
      for (const text of texts) {
        if (failOn?.(text)) {
          throw new Error(`fake provider configured to fail on text: ${JSON.stringify(text)}`);
        }
      }
      const vectors = texts.map((text) => hashToVector(text, dim));
      assertEmbeddingShape(vectors, texts, dim, NAME);
      textsEmbedded += vectors.length;
      return vectors;
    },

    async close(): Promise<void> {
      closed = true;
    },
  };
}
