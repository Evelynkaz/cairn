// The library behind the CLI's lifecycle and embedding commands
// (BUILD_BRIEF §11, §16.5). This module owns no argument parsing and does
// no printing -- the CLI command layer (a later round) does that. It also
// never launches a browser: a library that opens a GUI as a side effect of
// a status check is untestable.

import { connect } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { dbPath, resolveCairnHome } from "../config/paths.js";
import { openDb } from "../storage/db.js";
import { ensureDaemon } from "../shim/ensure-daemon.js";
import {
  isDaemonAlive,
  pidIsAlive,
  readRuntimeFile,
  removeRuntimeFile,
} from "../daemon/runtime-file.js";
import {
  describeConfig,
  resolveEmbeddingConfig,
  setEmbeddingConfig,
  VALID_PROVIDER_NAMES,
} from "../embeddings/registry.js";
import { explainUnavailable } from "../embeddings/factory.js";
import { missingRuntimeMessage } from "../embeddings/local-onnx.js";
import type { EmbeddingConfig } from "../embeddings/registry.js";
import type { ProviderName } from "../embeddings/types.js";

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  port?: number;
  url?: string;
  uptimeMs?: number;
  memories?: number;
  vectors?: boolean;
  journalMode?: string | null;
  version?: string;
  // A runtime file exists but names a dead daemon -- the ordinary state
  // after a reboot or a crash, so it is reported as information, not
  // folded into `running` as an error.
  staleRuntimeFile?: boolean;
}

interface HealthBody {
  version?: string;
  uptimeMs?: number;
  memories?: number;
  vectors?: boolean;
  journalMode?: string | null;
}

function isHealthBody(value: unknown): value is HealthBody {
  return typeof value === "object" && value !== null;
}

// Never throws: a status command that crashes tells the user nothing.
export async function daemonStatus(home?: string): Promise<DaemonStatus> {
  const resolvedHome = home ?? resolveCairnHome();
  const info = readRuntimeFile(resolvedHome);
  if (!info) {
    return { running: false };
  }
  if (!(await isDaemonAlive(info))) {
    return { running: false, staleRuntimeFile: true };
  }
  const url = `http://127.0.0.1:${info.port}`;
  const base: DaemonStatus = { running: true, pid: info.pid, port: info.port, url };
  try {
    const res = await fetch(`${url}/health`);
    if (!res.ok) {
      return base;
    }
    const body: unknown = await res.json();
    if (!isHealthBody(body)) {
      return base;
    }
    return {
      ...base,
      version: body.version,
      uptimeMs: body.uptimeMs,
      memories: body.memories,
      vectors: body.vectors,
      journalMode: body.journalMode,
    };
  } catch {
    // The pid and port both checked alive above, but the HTTP round trip
    // itself can still fail (e.g. the daemon died between those checks) --
    // still a live daemon as far as this call is concerned, just one that
    // could not be asked for its extra detail.
    return base;
  }
}

export async function startDaemonDetached(
  options: { home?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ url: string; token: string; started: boolean; pid?: number }> {
  // Delegates to ensureDaemon rather than reimplementing spawning: that is
  // the one place that already knows how to find the daemon entrypoint and
  // handle the two-clients-race case (see its own comments).
  const result = await ensureDaemon(options);
  return { url: result.url, token: result.token, started: result.started, pid: result.spawnedPid };
}

const STOP_POLL_INTERVAL_MS = 100;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

function probePort(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const finish = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitUntilPortDead(port: number, deadline: number): Promise<boolean> {
  for (;;) {
    if (!(await probePort(port))) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_INTERVAL_MS));
  }
}

export async function stopDaemon(
  options: { home?: string; timeoutMs?: number } = {},
): Promise<{ stopped: boolean; pid?: number; detail?: string }> {
  const home = options.home ?? resolveCairnHome();
  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  const info = readRuntimeFile(home);
  if (!info) {
    return { stopped: false, detail: "no daemon is running (no runtime file found)" };
  }
  if (!(await isDaemonAlive(info))) {
    // isDaemonAlive failing covers two different situations, and they get
    // different messages: a dead pid is the ordinary post-crash/post-reboot
    // state, while a LIVE pid that fails the /health identity check means
    // the runtime file's pid+port now belongs to some unrelated process
    // (pid reuse, or a foreign service that took the recorded port) -- that
    // process must never be signalled. Either way clean up the stale file
    // while we're here.
    removeRuntimeFile(home);
    if (!pidIsAlive(info.pid)) {
      return {
        stopped: false,
        pid: info.pid,
        detail: `no daemon is running; removed a stale runtime file that named a dead process (pid ${info.pid})`,
      };
    }
    return {
      stopped: false,
      pid: info.pid,
      detail: "the process named by the runtime file is not the cairn daemon; removed the stale runtime file",
    };
  }

  try {
    // On Windows, process.kill(pid, "SIGTERM") terminates the process
    // outright -- Windows has no SIGTERM semantics, so the daemon's own
    // POSIX signal handler (main.ts) never runs there, and it never gets
    // the chance to remove its own runtime file. Handle that below once
    // the port is confirmed dead, instead of relying on the daemon to
    // have cleaned up after itself.
    process.kill(info.pid, "SIGTERM");
  } catch (error) {
    return {
      stopped: false,
      pid: info.pid,
      detail: `failed to signal pid ${info.pid}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const deadline = Date.now() + timeoutMs;
  const died = await waitUntilPortDead(info.port, deadline);
  if (!died) {
    return {
      stopped: false,
      pid: info.pid,
      detail: `daemon (pid ${info.pid}) did not stop within ${timeoutMs}ms`,
    };
  }

  // Only remove the runtime file if it still names the daemon we just
  // stopped -- another daemon may have started since. On POSIX this is
  // usually a no-op (the daemon's own shutdown already removed it); on
  // Windows it is the cleanup the SIGTERM handler never got to run (see
  // the comment above).
  const remaining = readRuntimeFile(home);
  if (remaining && remaining.pid === info.pid) {
    removeRuntimeFile(home);
  }
  return { stopped: true, pid: info.pid };
}

export async function uiUrl(home?: string): Promise<string | null> {
  const status = await daemonStatus(home);
  if (!status.running || !status.url) {
    return null;
  }
  return `${status.url}/ui`;
}

export interface EmbeddingStatus {
  provider: string;
  modelId: string | null;
  consented: boolean;
  source: string;
  available: boolean;
  reason: string | null;
}

// The exact wording createLocalProvider's own missingRuntimeError produces
// (src/embeddings/local-onnx.ts), imported rather than duplicated (this
// project has already been bitten by a drifted duplicate user-facing
// message once). Checking resolvability via require.resolve below never
// executes or downloads anything -- calling createProviderFromConfig
// instead would, for a consented local provider, actually load (and, if the
// package IS present but the model is not yet cached, download) it, which
// BUILD_BRIEF §2 forbids as the side effect of a configuration command.
function missingLocalRuntimeReason(home: string): string {
  return missingRuntimeMessage(home);
}

function isLocalProviderName(name: string): name is "local-onnx" | "local-static" {
  return name === "local-onnx" || name === "local-static";
}

// Package resolution only, never a module load: require.resolve() locates
// the file the same way createLocalProvider's own resolveRuntime() would,
// without importing (and so without executing or downloading) it.
function localRuntimeInstalled(home: string): boolean {
  const require = createRequire(import.meta.url);
  try {
    require.resolve("@huggingface/transformers");
    return true;
  } catch {
    // Fall through to the CAIRN_HOME install location below.
  }
  try {
    require.resolve(join(home, "node_modules", "@huggingface", "transformers", "package.json"));
    return true;
  } catch {
    return false;
  }
}

function computeAvailability(config: EmbeddingConfig, home: string): { available: boolean; reason: string | null } {
  if (config.provider === "off") {
    return { available: false, reason: describeConfig(config) };
  }
  const unavailable = explainUnavailable(config);
  if (unavailable !== null) {
    return { available: false, reason: unavailable };
  }
  if (isLocalProviderName(config.provider) && !localRuntimeInstalled(home)) {
    return { available: false, reason: missingLocalRuntimeReason(home) };
  }
  return { available: true, reason: null };
}

function toStatus(config: EmbeddingConfig, home: string): EmbeddingStatus {
  const { available, reason } = computeAvailability(config, home);
  return {
    provider: config.provider,
    modelId: config.modelId,
    consented: config.consented,
    source: config.source,
    available,
    reason,
  };
}

export function embeddingStatus(home?: string): EmbeddingStatus {
  const resolvedHome = home ?? resolveCairnHome();
  const db = openDb({ path: dbPath(resolvedHome) });
  try {
    return toStatus(resolveEmbeddingConfig(db), resolvedHome);
  } finally {
    db.close();
  }
}

function isKnownProviderName(name: string): name is ProviderName {
  return (VALID_PROVIDER_NAMES as readonly string[]).includes(name);
}

// Distinct from missingLocalRuntimeReason above: that one explains an
// ordinary status check's "not available" (e.g. `cairn embeddings status`,
// which never just ran a command). Right after enableEmbeddings has just
// recorded consent, telling the user to go run `cairn embeddings enable`
// again would be circular -- the accurate next step is the one thing
// consenting deliberately does NOT do (§2): installing the runtime.
function postConsentReason(home: string): string {
  return (
    "Consent recorded. Semantic search will activate once the local embedding " +
    `runtime is installed. Install it with: npm install --prefix ${home} @huggingface/transformers.`
  );
}

export function enableEmbeddings(
  options: { home?: string; provider?: string; modelId?: string } = {},
): EmbeddingStatus {
  const resolvedHome = options.home ?? resolveCairnHome();
  const providerRaw = options.provider ?? "local-onnx";
  if (!isKnownProviderName(providerRaw)) {
    throw new Error(
      `unknown embedding provider "${providerRaw}"; valid providers are: ${VALID_PROVIDER_NAMES.join(", ")}`,
    );
  }
  const provider = providerRaw;
  const db = openDb({ path: dbPath(resolvedHome) });
  try {
    // Persists the choice only. §2 forbids a model download as the side
    // effect of a configuration command -- the download happens later, on
    // first use, by the daemon's own background indexer. Consenting is not
    // the same as the user waiting.
    setEmbeddingConfig(db, { provider, modelId: options.modelId, consented: true });
    const status = toStatus(resolveEmbeddingConfig(db), resolvedHome);
    if (!status.available && isLocalProviderName(status.provider) && !localRuntimeInstalled(resolvedHome)) {
      return { ...status, reason: postConsentReason(resolvedHome) };
    }
    return status;
  } finally {
    db.close();
  }
}

export function disableEmbeddings(home?: string): EmbeddingStatus {
  const resolvedHome = home ?? resolveCairnHome();
  const db = openDb({ path: dbPath(resolvedHome) });
  try {
    setEmbeddingConfig(db, { provider: "off", consented: false });
    return toStatus(resolveEmbeddingConfig(db), resolvedHome);
  } finally {
    db.close();
  }
}
