// Local ONNX / static embedding providers (BUILD_BRIEF §3 default and fast
// fallback). `@huggingface/transformers` ships onnxruntime (~100+ MB) and is
// therefore declared in package.json as an OPTIONAL PEER dependency, not a
// regular or optional dependency: npm installs `optionalDependencies`
// automatically on every install, which would pull that weight into every
// `npx cairn` run (including FTS-only users) and break the §2 zero-config,
// instant-start promise. An optional PEER dependency is never auto-installed,
// so the runtime only shows up once the user explicitly installs it (e.g.
// `npm install --prefix <CAIRN_HOME> @huggingface/transformers`) --
// `cairn embeddings enable` records consent to use it, it never installs
// it. This module resolves it lazily, at call time, and fails with an
// actionable message when it is missing.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCairnHome } from "../config/paths.js";
import type { EmbeddingProvider, ProviderName } from "./types.js";
import { assertEmbeddingShape, normalize } from "./types.js";

export interface LocalProviderOptions {
  name: "local-onnx" | "local-static";
  modelId?: string;
  cacheDir?: string;
}

const DEFAULT_MODEL_IDS: Record<"local-onnx" | "local-static", string> = {
  "local-onnx": "Xenova/bge-small-en-v1.5",
  "local-static": "minishlab/potion-retrieval-32M",
};

// Not a string literal on purpose: TypeScript only attempts to statically
// resolve (and type-check against installed declarations) a dynamic
// `import()` whose specifier is a literal. Routing the specifier through a
// variable keeps this file compiling even though the runtime is not
// installed by default (see the header comment above).
const RUNTIME_SPECIFIER = "@huggingface/transformers";

interface FeatureExtractionOutput {
  data: ArrayLike<number>;
  dims: readonly number[];
}

interface FeatureExtractionPipeline {
  (texts: string[], options?: { pooling?: string; normalize?: boolean }): Promise<FeatureExtractionOutput>;
  dispose?: () => Promise<void>;
  model?: {
    config?: { hidden_size?: number };
    dispose?: () => Promise<void>;
  };
}

interface TransformersRuntime {
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<FeatureExtractionPipeline>;
  env: {
    cacheDir?: string;
    [key: string]: unknown;
  };
}

// Resolves the cache directory transformers.js downloads models into.
// Exported so it can be verified without loading the (possibly absent)
// runtime: it must land inside CAIRN_HOME by default, so a full `cairn
// uninstall` / deleting CAIRN_HOME removes downloaded models too (§10).
export function resolveCacheDir(cacheDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  return cacheDir ?? join(resolveCairnHome(env), "models");
}

// Exported so other modules that need to explain the same "runtime not
// installed" situation (e.g. the CLI's `embeddingStatus`, which diagnoses
// this via require.resolve() rather than by actually loading the runtime)
// never carry their own, independently-drifting copy of this wording.
export function missingRuntimeMessage(home: string): string {
  return (
    "semantic search needs the local embedding runtime, which is not installed. " +
    `Install it with: npm install --prefix ${home} @huggingface/transformers ` +
    "(after consenting via: cairn embeddings enable, which records consent but does not install it). " +
    "Cairn keeps working with keyword search in the meantime."
  );
}

function missingRuntimeError(home: string, cause: unknown): Error {
  return new Error(missingRuntimeMessage(home), { cause });
}

// Distinct from missingRuntimeError: the package IS present at packageDir,
// so telling the user to (re)run the same `npm install` that produced this
// broken install would just fail the same way again. Real triggers include
// a native onnxruntime-node binding
// mismatch (common on Windows and musl), a half-finished npm install, or a
// wrong-architecture prebuild; the original error is attached as `cause` so
// that reason is visible to whoever debugs it.
function brokenRuntimeError(packageDir: string, cause: unknown): Error {
  return new Error(
    `the local embedding runtime was found at "${packageDir}" but failed to load. ` +
      "This usually means a corrupt or architecture-mismatched install, not a missing one; " +
      "see the attached cause for details.",
    { cause },
  );
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function importRuntime(specifier: string): Promise<unknown> {
  return import(specifier);
}

// Second location: the runtime installed into CAIRN_HOME/node_modules by
// `npm install --prefix <CAIRN_HOME> @huggingface/transformers` (never by
// `cairn embeddings enable`, which only records consent, and never into
// this package's own node_modules). The package's own package.json is read
// to find its ESM entry point rather than assuming a fixed file layout.
async function resolveCairnHomeEntryUrl(packageDir: string): Promise<string> {
  const pkgRaw = await readFile(join(packageDir, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw) as { main?: string; module?: string; exports?: unknown };
  const entryRelative = pickEntry(pkg);
  return pathToFileURL(join(packageDir, entryRelative)).href;
}

// Reads a string leaf out of a conditional-exports node, honouring a single
// level of nesting for the given condition key (e.g. `node.import` or
// `node.require`).
function stringLeaf(node: unknown): string | undefined {
  return typeof node === "string" ? node : undefined;
}

// `pkg.exports["."]` can itself be a nested conditional-exports object, not
// just `{ import: "..." }`. @huggingface/transformers publishes
// `{ node: { import: "./dist/transformers.mjs", require: "./dist/transformers.cjs" },
// default: "./dist/transformers.js" }`: there is no top-level "import" key
// at all, so a resolver that only checks `root.import` falls through to
// `pkg.module`/`pkg.main`, which for this package is the BROWSER build, not
// the Node one. "node" must therefore be walked (then its own "import",
// then its own "require") before falling back to "default".
// Exported so it can be verified against a package.json shape without
// needing the runtime installed (see resolveCacheDir above for the same
// reasoning).
export function pickEntry(pkg: { main?: string; module?: string; exports?: unknown }): string {
  const exportsField = pkg.exports;
  if (typeof exportsField === "string") {
    return exportsField;
  }
  if (exportsField && typeof exportsField === "object") {
    const root = (exportsField as Record<string, unknown>)["."];
    if (typeof root === "string") {
      return root;
    }
    if (root && typeof root === "object") {
      const record = root as Record<string, unknown>;
      const direct = stringLeaf(record["import"]);
      if (direct !== undefined) {
        return direct;
      }
      const node = record["node"];
      if (node && typeof node === "object") {
        const nodeRecord = node as Record<string, unknown>;
        const nodeImport = stringLeaf(nodeRecord["import"]);
        if (nodeImport !== undefined) {
          return nodeImport;
        }
        const nodeRequire = stringLeaf(nodeRecord["require"]);
        if (nodeRequire !== undefined) {
          return nodeRequire;
        }
      }
      const def = stringLeaf(record["default"]);
      if (def !== undefined) {
        return def;
      }
    }
  }
  // `exports` is preferred over `module`/`main` above; only fall back to
  // them when `exports` yielded nothing usable.
  return pkg.module ?? pkg.main ?? "index.js";
}

async function resolveRuntime(env: NodeJS.ProcessEnv): Promise<TransformersRuntime> {
  let firstAttemptError: unknown;
  try {
    return (await importRuntime(RUNTIME_SPECIFIER)) as TransformersRuntime;
  } catch (error) {
    // Not resolvable as a plain import (not installed as a peer dependency
    // of this package); try the CAIRN_HOME install location next.
    firstAttemptError = error;
  }
  const packageDir = join(resolveCairnHome(env), "node_modules", "@huggingface", "transformers");
  let entryUrl: string;
  try {
    entryUrl = await resolveCairnHomeEntryUrl(packageDir);
  } catch (error) {
    if (isEnoent(error)) {
      throw missingRuntimeError(resolveCairnHome(env), firstAttemptError);
    }
    throw brokenRuntimeError(packageDir, error);
  }
  try {
    return (await importRuntime(entryUrl)) as TransformersRuntime;
  } catch (error) {
    throw brokenRuntimeError(packageDir, error);
  }
}

function tensorToVectors(output: FeatureExtractionOutput, batchSize: number): Float32Array[] {
  const dims = output.dims;
  const dim = dims[dims.length - 1] ?? 0;
  const flat = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);
  const vectors: Float32Array[] = [];
  for (let i = 0; i < batchSize; i++) {
    vectors.push(flat.slice(i * dim, (i + 1) * dim));
  }
  return vectors;
}

async function runPipeline(pipe: FeatureExtractionPipeline, texts: string[]): Promise<Float32Array[]> {
  const output = await pipe(texts, { pooling: "mean", normalize: false });
  return tensorToVectors(output, texts.length);
}

export async function createLocalProvider(options: LocalProviderOptions): Promise<EmbeddingProvider> {
  const env = process.env;
  const name: ProviderName = options.name;
  const modelId = options.modelId ?? DEFAULT_MODEL_IDS[options.name];
  const cacheDir = resolveCacheDir(options.cacheDir, env);

  const runtime = await resolveRuntime(env);
  runtime.env.cacheDir = cacheDir;
  const pipe = await runtime.pipeline("feature-extraction", modelId, {});

  // Prefer the dimension the model itself reports; fall back to (and cross
  // check against) the length of the first embedding actually produced, so
  // a mismatch fails loudly at the provider boundary instead of corrupting
  // the memory<->vector mapping deep inside sqlite-vec.
  const configDim = pipe.model?.config?.hidden_size;
  const [probe] = await runPipeline(pipe, ["cairn embedding dimension probe"]);
  const probedDim = probe?.length ?? 0;
  if (configDim !== undefined && configDim !== probedDim) {
    throw new Error(
      `model "${modelId}" reports hidden_size ${configDim} but produced an embedding of length ${probedDim}`,
    );
  }
  const dim = configDim ?? probedDim;

  let closed = false;

  return {
    // Namespaced by provider name so that "local-onnx" and "local-static"
    // never collide in vector_spaces even if they were ever given the same
    // bare model name -- see the `modelId` contract in types.ts. The bare
    // `modelId` above (without the namespace) is what actually goes to
    // runtime.pipeline(), since that's what @huggingface/transformers expects.
    modelId: `${name}:${modelId}`,
    dim,
    name,
    // After the one-time model fetch above, embedding is pure local compute
    // (§2/§3): no network call happens inside embed(). Obtaining the user's
    // consent to that one-time fetch is the registry's job (EmbeddingConfig
    // .consented), not this module's -- this module only resolves and runs
    // the runtime once it has already been asked to.
    requiresNetwork: false,

    async embed(texts: string[]): Promise<Float32Array[]> {
      if (closed) {
        throw new Error(`local provider "${modelId}" was used after close()`);
      }
      const vectors = await runPipeline(pipe, texts);
      const normalized = vectors.map((v) => normalize(v));
      assertEmbeddingShape(normalized, texts, dim, name);
      return normalized;
    },

    async close(): Promise<void> {
      closed = true;
      if (pipe.dispose) {
        await pipe.dispose();
      } else if (pipe.model?.dispose) {
        await pipe.model.dispose();
      }
    },
  };
}
