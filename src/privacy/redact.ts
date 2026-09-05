import { detectSecrets, type Finding } from "./detectors.js";

export type PrivacyMode = "off" | "on" | "strict";

export interface RedactionResult {
  text: string;
  findings: Finding[];
  blocked: boolean;
}

// Ingest defaults to redacting secrets rather than passing them through
// unchanged (BUILD_BRIEF §10).
export const DEFAULT_PRIVACY_MODE: PrivacyMode = "on";

function markerFor(finding: Finding): string {
  return `[redacted:${finding.kind}]`;
}

// Replaces each finding's span with a marker naming its kind. Findings are
// assumed sorted by `start` with no overlaps (as `detectSecrets` guarantees),
// so splicing left-to-right never places a marker inside another marker.
function spliceMarkers(text: string, findings: readonly Finding[]): string {
  let out = "";
  let cursor = 0;
  for (const finding of findings) {
    out += text.slice(cursor, finding.start);
    out += markerFor(finding);
    cursor = finding.end;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Applies the privacy mode to `text` (BUILD_BRIEF §10):
 *
 * - `off`: returns the text unchanged and does not even run the detectors,
 *   so choosing `off` is genuinely free.
 * - `on`: replaces each finding with a `[redacted:<kind>]` marker and
 *   returns the rewritten text with `blocked: false`.
 * - `strict`: detects but returns the ORIGINAL text untouched, with
 *   `blocked: true` so the caller refuses the write. Strict does not also
 *   redact-and-store: the point of strict is that the user finds out and
 *   decides, not that we silently keep a rewritten version of something
 *   they did not want stored at all.
 *
 * Deterministic: the same input always produces the same output.
 */
export function redactText(text: string, mode: PrivacyMode): RedactionResult {
  if (mode === "off") {
    return { text, findings: [], blocked: false };
  }

  const findings = detectSecrets(text);

  if (mode === "strict") {
    return { text, findings, blocked: findings.length > 0 };
  }

  return { text: spliceMarkers(text, findings), findings, blocked: false };
}
