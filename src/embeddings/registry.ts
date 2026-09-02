// Embedding configuration and consent resolution. BUILD_BRIEF §2 requires
// `npx cairn` to work immediately with no model download, so the default
// here is FTS-only ("off"), and a real provider is only ever used after the
// user has explicitly consented to a download.

import type { CairnDb } from "../storage/db.js";
import type { ProviderName } from "./types.js";

export interface EmbeddingConfig {
  provider: ProviderName;
  /** Provider-specific default when not overridden. */
  modelId: string | null;
  /** Whether the user has agreed to a model download. */
  consented: boolean;
  source: "env" | "settings" | "default";
}

const ENV_VAR = "CAIRN_EMBEDDINGS";
const KEY_PROVIDER = "embeddings.provider";
const KEY_MODEL_ID = "embeddings.modelId";
const KEY_CONSENTED = "embeddings.consented";

// Every name resolveEmbeddingConfig can produce from configuration. "fake"
// is deliberately excluded: it exists only for tests to construct directly
// (see fake.ts) and must never be reachable through env or settings.
const VALID_PROVIDER_NAMES: readonly ProviderName[] = [
  "off",
  "local-onnx",
  "local-static",
  "ollama",
  "openai",
  "voyage",
];

function isValidProviderName(value: string): value is ProviderName {
  return (VALID_PROVIDER_NAMES as readonly string[]).includes(value);
}

// "off" is a fully supported mode (FTS-only search), not an error state or
// a degraded fallback -- it is what makes the zero-config, no-download
// first run of BUILD_BRIEF §2 possible.
const DEFAULT_CONFIG: EmbeddingConfig = {
  provider: "off",
  modelId: null,
  consented: false,
  source: "default",
};

function readSetting(db: CairnDb, key: string): string | undefined {
  const row = db.q("select value from settings where key = ?").get(key);
  return row ? String(row["value"]) : undefined;
}

function writeSetting(db: CairnDb, key: string, value: string): void {
  db.q(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

// Settings values live in the user's .db file (BUILD_BRIEF §1: it is theirs
// to inspect, back up, or hand-edit), not input we control at write time.
// A malformed row there is a corrupted store, not user input to reject --
// BUILD_BRIEF §2's zero-config promise means a bad settings row must never
// make the daemon unstartable, so this falls back to "off" instead of
// throwing. Nothing is logged: stdout is reserved for the MCP stdio
// transport (see db.ts), and the caller surfaces this via `source` /
// `describeConfig` instead.
function resolveFromSettings(db: CairnDb): EmbeddingConfig | undefined {
  const providerRaw = readSetting(db, KEY_PROVIDER);
  const modelId = readSetting(db, KEY_MODEL_ID);
  const consentedRaw = readSetting(db, KEY_CONSENTED);
  if (providerRaw === undefined && modelId === undefined && consentedRaw === undefined) {
    return undefined;
  }
  if (providerRaw !== undefined && !isValidProviderName(providerRaw)) {
    return { provider: "off", modelId: null, consented: false, source: "settings" };
  }
  return {
    provider: providerRaw ?? "off",
    modelId: modelId ?? null,
    consented: consentedRaw === "1",
    source: "settings",
  };
}

// Unlike a settings row, the env var is live operator input (a launch flag,
// a shell export) that the operator can see and immediately correct, so an
// unknown value here throws rather than silently degrading to "off". Only
// the provider name is ever read from the env var -- there is no
// CAIRN_EMBEDDINGS_MODEL_ID or CAIRN_EMBEDDINGS_CONSENTED, so this can never
// itself carry a modelId or a consented flag.
function resolveProviderFromEnv(env: NodeJS.ProcessEnv): ProviderName | undefined {
  const raw = env[ENV_VAR];
  if (raw === undefined) {
    return undefined;
  }
  if (!isValidProviderName(raw)) {
    throw new Error(
      `${ENV_VAR}="${raw}" is not a valid embedding provider; valid values are: ${VALID_PROVIDER_NAMES.join(", ")}`,
    );
  }
  return raw;
}

// Precedence: CAIRN_EMBEDDINGS env var > `settings` table > default. Only
// `source` tells a caller (the dashboard, the CLI) which of the three won,
// which matters because "an env var overrides your saved setting" is a real
// answer the user needs to be able to see.
//
// IMPORTANT: the env var overrides only the PROVIDER field, never the whole
// config. Settings are resolved first, and if the env var is set it is
// applied as a provider override on top of that -- "env wins" means "env
// wins the provider", not "env replaces modelId and consented too". Those
// two are read from settings even when the env var fires: modelId is the
// user's saved model choice, and consented is the user's saved decision to
// allow a model download, and neither one is something the env var can even
// express (see resolveProviderFromEnv above). Treating a bare provider-name
// env var as a full config reset would silently discard the user's consent
// and their chosen model every time it happens to name the SAME provider as
// settings, and would silently fall back to a different provider's default
// model (re-embedding the whole store under a new vector space) when it
// names a DIFFERENT one.
export function resolveEmbeddingConfig(db: CairnDb, env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const base = resolveFromSettings(db) ?? DEFAULT_CONFIG;
  const envProvider = resolveProviderFromEnv(env);
  if (envProvider === undefined) {
    return base;
  }
  // The stored modelId belongs to the stored provider. If the env var names
  // a DIFFERENT provider, that modelId is meaningless for it (may not even
  // be a valid model name there), so it is dropped to null and the new
  // provider's own default applies instead. `consented` is a standalone
  // user decision ("may Cairn download a model at all"), not tied to which
  // provider is selected, so it is always kept.
  const modelId = envProvider === base.provider ? base.modelId : null;
  return { provider: envProvider, modelId, consented: base.consented, source: "env" };
}

// Persists provider/modelId/consented into `settings` under the
// `embeddings.` prefix. Never persists an API key: BUILD_BRIEF §10 makes
// "API provider keys never touch the database" a privacy commitment, not a
// style choice -- an openai/voyage/ollama provider must read its key from
// the environment only, at use time, every time.
export function setEmbeddingConfig(
  db: CairnDb,
  patch: { provider?: ProviderName; modelId?: string | null; consented?: boolean },
): EmbeddingConfig {
  return db.tx(() => {
    if (patch.provider !== undefined) {
      writeSetting(db, KEY_PROVIDER, patch.provider);
    }
    if (patch.modelId !== undefined) {
      if (patch.modelId === null) {
        db.q("delete from settings where key = ?").run(KEY_MODEL_ID);
      } else {
        writeSetting(db, KEY_MODEL_ID, patch.modelId);
      }
    }
    if (patch.consented !== undefined) {
      writeSetting(db, KEY_CONSENTED, patch.consented ? "1" : "0");
    }
    return resolveFromSettings(db) ?? DEFAULT_CONFIG;
  });
}

export function describeConfig(config: EmbeddingConfig): string {
  if (config.provider === "off") {
    const because =
      config.source === "env" ? ` (set by ${ENV_VAR})` : config.source === "settings" ? " (set in settings)" : "";
    return `Semantic search is off; memory search is keyword-only (FTS)${because}.`;
  }
  const modelNote = config.modelId ? ` model "${config.modelId}"` : "";
  const consentNote = config.consented ? "" : ", awaiting consent to download the model";
  return `Semantic search uses provider "${config.provider}"${modelNote}${consentNote} (from ${config.source}).`;
}
