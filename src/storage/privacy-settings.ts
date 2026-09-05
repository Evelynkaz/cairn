// Privacy mode configuration and resolution (BUILD_BRIEF §10). Mirrors the
// env/settings/default precedence rule that ../embeddings/registry.ts
// already learned the hard way: the env var overrides only the MODE, and an
// invalid settings value falls back silently rather than making the daemon
// unstartable (a corrupted settings row is a corrupted store, not user
// input to reject), while an invalid env var throws (the operator can see
// and immediately correct a launch flag or shell export).

import type { CairnDb } from "./db.js";
import type { PrivacyMode } from "../privacy/index.js";
import { DEFAULT_PRIVACY_MODE } from "../privacy/index.js";

export interface PrivacyConfig {
  mode: PrivacyMode;
  source: "env" | "settings" | "default";
}

const ENV_VAR = "CAIRN_PRIVACY";
const KEY_MODE = "privacy.mode";

export const VALID_PRIVACY_MODES: readonly PrivacyMode[] = ["off", "on", "strict"];

function isValidPrivacyMode(value: string): value is PrivacyMode {
  return (VALID_PRIVACY_MODES as readonly string[]).includes(value);
}

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

// Settings values live in the user's .db file, not input we control at
// write time. A malformed row there is a corrupted store, not user input to
// reject -- §10's privacy protection must never make the daemon
// unstartable, so an invalid stored mode falls back to the default instead
// of throwing.
function resolveFromSettings(db: CairnDb): PrivacyConfig | undefined {
  const raw = readSetting(db, KEY_MODE);
  if (raw === undefined) return undefined;
  if (!isValidPrivacyMode(raw)) {
    return { mode: DEFAULT_PRIVACY_MODE, source: "default" };
  }
  return { mode: raw, source: "settings" };
}

// Unlike a settings row, the env var is live operator input that the
// operator can see and immediately correct, so an unknown value here throws
// rather than silently degrading.
function resolveModeFromEnv(env: NodeJS.ProcessEnv): PrivacyMode | undefined {
  const raw = env[ENV_VAR];
  if (raw === undefined) return undefined;
  if (!isValidPrivacyMode(raw)) {
    throw new Error(
      `${ENV_VAR}="${raw}" is not a valid privacy mode; valid values are: ${VALID_PRIVACY_MODES.join(", ")}`,
    );
  }
  return raw;
}

// Precedence: CAIRN_PRIVACY env var > `settings` table > default ("on" --
// §10 makes privacy a feature, so the protective mode is what an untouched
// install gets).
export function resolvePrivacyMode(db: CairnDb, env: NodeJS.ProcessEnv = process.env): PrivacyConfig {
  const base = resolveFromSettings(db) ?? { mode: DEFAULT_PRIVACY_MODE, source: "default" as const };
  const envMode = resolveModeFromEnv(env);
  if (envMode === undefined) return base;
  return { mode: envMode, source: "env" };
}

// Persists the mode into `settings` under the `privacy.` prefix.
export function setPrivacyMode(db: CairnDb, mode: PrivacyMode): PrivacyConfig {
  if (!isValidPrivacyMode(mode)) {
    throw new Error(`invalid privacy mode "${mode}"; valid values are: ${VALID_PRIVACY_MODES.join(", ")}`);
  }
  writeSetting(db, KEY_MODE, mode);
  return { mode, source: "settings" };
}
