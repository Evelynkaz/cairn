// The Claude Code `SessionStart` hook (`cairn hook session-start`,
// BUILD_BRIEF §8): makes recall deterministic instead of depending on the
// model choosing to call a tool -- instruction-only orchestration ("remember
// to call recall") is only 60-70% reliable. Fetches a token-budgeted ranked
// index from the local daemon over HTTP (`GET /api/context`, which the
// daemon already enforces the ~800-token budget on -- see
// src/retrieval/context.ts and §8/§14's "context pollution" failure) and
// prints it in Claude Code's hook envelope.
//
// SAFETY CONTRACT -- this must never be able to harm a session. Two
// independent readings of Claude Code's hook documentation disagreed about
// whether exit code 2 blocks session startup and about the default timeout
// (60s vs 600s), so this is written to not care which is right:
//   - it never exits non-zero, for any reason (see the CLI wrapper in
//     commands.ts, which always returns 0 for this command);
//   - stdout carries only the envelope, or nothing at all -- for
//     SessionStart, plain stdout is injected straight into the model's
//     context, so a stray diagnostic line here would be something the model
//     reads and may act on. Every failure path below resolves to "" rather
//     than throwing or writing anywhere;
//   - it enforces its OWN deadline (~2s), rather than trusting whichever of
//     the two timeout readings turns out to be true.
// A session that starts instantly with no memory injected is strictly
// better than one that hangs, or one that gets a stray line read as an
// instruction.

import { readRuntimeFile, isDaemonAlive } from "../daemon/runtime-file.js";
import type { RuntimeInfo } from "../daemon/runtime-file.js";
import { startDaemonDetached } from "./lifecycle.js";

const DEFAULT_DEADLINE_MS = 2000;

// Kept to one sentence (per spec) so the model knows this is Cairn's own
// stored memory, not something the user just said.
const CONTEXT_PREFIX =
  "The following is memory Cairn has stored from earlier sessions, not something the user just typed:\n\n";

export interface SessionStartHookOptions {
  home?: string;
  // Test-only: production always uses the ~2s default.
  deadlineMs?: number;
  // Draining stdin is the CLI wrapper's job in production (it passes the
  // real process.stdin); tests inject a fake stream here instead of
  // touching the real one.
  stdin?: NodeJS.ReadableStream;
  // Test-only seam: production always uses the real startDaemonDetached.
  // Swapping this out is what lets a test prove "no daemon -> empty
  // output" without a real daemon process spawning in the background.
  startDaemon?: typeof startDaemonDetached;
}

export interface SessionStartHookResult {
  // "" means: print nothing. Otherwise this is the exact envelope line.
  stdout: string;
}

// Consumes and discards stdin so Claude Code's write to it never sees a
// broken pipe. Never awaited: a stdin that is never closed must not be able
// to delay this command past its own deadline (see runSessionStartHook).
function drainStdin(stdin: NodeJS.ReadableStream | undefined): void {
  if (!stdin) return;
  try {
    stdin.resume();
    stdin.on("data", () => {});
    stdin.on("error", () => {});
  } catch {
    // Best-effort only -- a hook that fails to drain stdin must still be
    // able to inject context (or inject nothing) rather than blow up.
  }
}

interface ContextApiResponse {
  text?: unknown;
}

function isContextApiResponse(value: unknown): value is ContextApiResponse {
  return typeof value === "object" && value !== null;
}

async function fetchContextText(info: RuntimeInfo, deadlineAt: number): Promise<string | null> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/context`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const body: unknown = await res.json();
    if (!isContextApiResponse(body) || typeof body.text !== "string" || body.text.trim() === "") {
      return null;
    }
    return body.text;
  } catch {
    // Covers a network error, our own deadline abort, and malformed JSON --
    // all of these mean "inject nothing", never a thrown error.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function computeContext(
  home: string | undefined,
  deadlineAt: number,
  startDaemon: typeof startDaemonDetached,
): Promise<string | null> {
  const info = readRuntimeFile(home);
  if (!info) {
    // Start one for the NEXT session, but never wait on it: ensureDaemon's
    // own default startup wait is 10s, many times this command's whole
    // deadline. A session that starts instantly with no memory now is
    // strictly better than one that stalls waiting for a cold daemon.
    startDaemon({ home }).catch(() => {});
    return null;
  }
  if (!(await isDaemonAlive(info))) {
    startDaemon({ home }).catch(() => {});
    return null;
  }
  return fetchContextText(info, deadlineAt);
}

export async function runSessionStartHook(
  options: SessionStartHookOptions = {},
): Promise<SessionStartHookResult> {
  drainStdin(options.stdin);
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const deadlineAt = Date.now() + deadlineMs;
  const startDaemon = options.startDaemon ?? startDaemonDetached;

  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), deadlineMs);
  });

  let text: string | null;
  try {
    text = await Promise.race([computeContext(options.home, deadlineAt, startDaemon), timeout]);
  } catch {
    text = null;
  }

  if (!text) {
    return { stdout: "" };
  }

  const envelope = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `${CONTEXT_PREFIX}${text}`,
    },
  };
  return { stdout: JSON.stringify(envelope) };
}
