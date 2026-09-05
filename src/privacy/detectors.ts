// Pure, dependency-free secret detection (BUILD_BRIEF §10). No I/O, no
// database, no network — this module only looks at the string it is given.
// Deliberately kept pure so it can be exhaustively unit tested: this is the
// code that decides whether a user's secret leaves their keyboard intact.

export type SecretKind =
  | "aws-access-key-id"
  | "aws-secret-access-key"
  | "github-token"
  | "openai-key"
  | "anthropic-key"
  | "slack-token"
  | "google-api-key"
  | "stripe-key"
  | "jwt"
  | "private-key-block"
  | "url-password"
  | "generic-bearer";

export interface Finding {
  kind: SecretKind;
  start: number;
  end: number;
  // A MASKED excerpt of the matched span — never the full value. A finding
  // is a thing we log, show in a dashboard, and put in error messages; if it
  // carried the secret we would have moved the leak rather than stopped it.
  preview: string;
}

const DEFAULT_MAX_FINDINGS = 100;

interface Candidate {
  kind: SecretKind;
  start: number;
  end: number;
  // Lower priority wins ties in length: earlier (more specific) detectors
  // beat later (more generic) ones when two candidates cover the exact same
  // span (e.g. an Anthropic key also satisfies the generic OpenAI shape).
  priority: number;
}

function maskPreview(value: string): string {
  const len = value.length;
  if (len <= 8) return "*".repeat(len);
  return `${value.slice(0, 4)}…${value.slice(len - 4)}`;
}

// Extracts [start, end] for a regex group using the 'd' (hasIndices) flag.
// groupIndex 0 means the whole match.
function groupSpan(match: RegExpExecArray, groupIndex: number): [number, number] | null {
  const indices = (match as RegExpExecArray & { indices?: Array<[number, number] | undefined> })
    .indices;
  if (groupIndex === 0) return [match.index, match.index + match[0].length];
  const span = indices?.[groupIndex];
  return span ?? null;
}

function collectSimple(
  text: string,
  kind: SecretKind,
  priority: number,
  regex: RegExp,
  groupIndex = 0,
): Candidate[] {
  const out: Candidate[] = [];
  for (const match of text.matchAll(regex)) {
    const span = groupSpan(match, groupIndex);
    if (span === null) continue;
    const [start, end] = span;
    if (end > start) out.push({ kind, start, end, priority });
  }
  return out;
}

// AWS access key id: AKIA (long-term) or ASIA (temporary/STS) + 16 uppercase
// alphanumeric characters. Does NOT match lowercase or shorter look-alikes.
const AWS_ACCESS_KEY_ID = /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/gd;

// AWS secret access key: a 40-char base64-ish string is far too common on
// its own, so this only fires when it appears as the value of an
// `aws_secret_access_key`-style assignment. Deliberately does NOT match a
// bare 40-char string anywhere else in the text.
const AWS_SECRET_ACCESS_KEY =
  /aws_secret_access_key\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gid;

// GitHub fine-grained/classic tokens: ghp_/gho_/ghu_/ghs_/ghr_ prefixes each
// followed by 36+ alphanumerics.
const GITHUB_TOKEN = /(?<![A-Za-z0-9_])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}(?![A-Za-z0-9_])/gd;

// GitHub fine-grained PAT: the github_pat_ prefix followed by a long
// alphanumeric/underscore body.
const GITHUB_PAT = /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}(?![A-Za-z0-9_])/gd;

// Anthropic key: sk-ant- prefix. Checked BEFORE the generic OpenAI sk-
// pattern so an Anthropic key is not also (mis)labelled as an OpenAI key.
const ANTHROPIC_KEY = /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/gd;

// OpenAI key: sk- or sk-proj- prefix. Requires a long tail so the bare
// literal "sk-" never matches on its own.
const OPENAI_KEY = /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/gd;

// Slack token: xoxb-/xoxa-/xoxp-/xoxr-/xoxs- prefix + a dash-delimited body.
const SLACK_TOKEN = /(?<![A-Za-z0-9_-])xox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9_-])/gd;

// Google API key: AIza + 35 alphanumeric/underscore/dash characters (the
// fixed length Google issues them at).
const GOOGLE_API_KEY = /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/gd;

// Stripe key: sk_/rk_/pk_ + live/test + a long alphanumeric body. A test key
// is still a credential, so both live and test variants are flagged.
const STRIPE_KEY = /(?<![A-Za-z0-9_-])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}(?![A-Za-z0-9_-])/gd;

// JWT: three dot-separated base64url segments where the first segment
// decodes to JSON containing an "alg" key. The decode check is what keeps
// this from firing on arbitrary dotted tokens.
const JWT_SHAPE = /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{10,})\.([A-Za-z0-9_-]{10,})\.([A-Za-z0-9_-]{10,})(?![A-Za-z0-9_-])/gd;

function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64").toString("utf8");
}

function collectJwt(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const match of text.matchAll(JWT_SHAPE)) {
    const header = match[1];
    if (header === undefined) continue;
    try {
      const decoded: unknown = JSON.parse(base64UrlDecode(header));
      if (
        typeof decoded === "object" &&
        decoded !== null &&
        "alg" in (decoded as Record<string, unknown>)
      ) {
        out.push({
          kind: "jwt",
          start: match.index,
          end: match.index + match[0].length,
          priority: 8,
        });
      }
    } catch {
      // Not a JWT: header segment did not decode to JSON with "alg".
    }
  }
  return out;
}

// Private key block: a full PEM-style -----BEGIN ... PRIVATE KEY----- through
// the matching -----END ... PRIVATE KEY----- (same label on both ends via
// the backreference), including the body.
const PRIVATE_KEY_BLOCK = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gd;

// URL password: scheme://user:password@host. Only the password span itself
// is captured — the scheme, user and host are not secrets.
const URL_PASSWORD = /(?<![A-Za-z0-9+.-])[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]+)@/gd;

// Generic bearer token: "Authorization: Bearer <token>" or bare
// "bearer <token>", case-insensitive. Only the token itself is captured.
// Requires a plausible token length so bare "Bearer" with nothing after it
// never matches.
const GENERIC_BEARER = /bearer\s+([A-Za-z0-9\-_.=]{10,})(?![A-Za-z0-9_-])/gid;

function collectAll(text: string): Candidate[] {
  return [
    ...collectSimple(text, "anthropic-key", 0, ANTHROPIC_KEY),
    ...collectSimple(text, "openai-key", 1, OPENAI_KEY),
    ...collectSimple(text, "aws-access-key-id", 2, AWS_ACCESS_KEY_ID),
    ...collectSimple(text, "aws-secret-access-key", 3, AWS_SECRET_ACCESS_KEY, 1),
    ...collectSimple(text, "github-token", 4, GITHUB_TOKEN),
    ...collectSimple(text, "github-token", 4, GITHUB_PAT),
    ...collectSimple(text, "slack-token", 5, SLACK_TOKEN),
    ...collectSimple(text, "google-api-key", 6, GOOGLE_API_KEY),
    ...collectSimple(text, "stripe-key", 7, STRIPE_KEY),
    ...collectJwt(text),
    ...collectSimple(text, "private-key-block", -1, PRIVATE_KEY_BLOCK),
    ...collectSimple(text, "url-password", 9, URL_PASSWORD, 1),
    ...collectSimple(text, "generic-bearer", 10, GENERIC_BEARER, 1),
  ];
}

/**
 * Detects high-confidence secret shapes in `text`. Precision over recall,
 * deliberately: a false positive mangles a user's own note, and for a
 * memory product that is worse than a miss — a missed token is a risk the
 * user may already be managing, a corrupted memory is the product breaking
 * its core promise. No entropy heuristics; only the specific shapes above.
 *
 * Results are sorted by `start`, with overlaps resolved by preferring the
 * longer match (ties broken by detector specificity) so a caller can splice
 * them without double-counting.
 */
export function detectSecrets(text: string, options?: { maxFindings?: number }): Finding[] {
  const maxFindings = options?.maxFindings ?? DEFAULT_MAX_FINDINGS;
  if (maxFindings <= 0) return [];

  const candidates = collectAll(text);
  // Prefer longer matches first; among equal-length candidates, prefer the
  // more specific (lower-priority-number) detector, then the earlier start.
  candidates.sort((a, b) => {
    const lenDiff = b.end - b.start - (a.end - a.start);
    if (lenDiff !== 0) return lenDiff;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.start - b.start;
  });

  const accepted: Candidate[] = [];
  for (const candidate of candidates) {
    if (accepted.length >= maxFindings) break;
    const overlaps = accepted.some((a) => candidate.start < a.end && a.start < candidate.end);
    if (!overlaps) accepted.push(candidate);
  }

  accepted.sort((a, b) => a.start - b.start);

  return accepted.slice(0, maxFindings).map((c) => ({
    kind: c.kind,
    start: c.start,
    end: c.end,
    preview: maskPreview(text.slice(c.start, c.end)),
  }));
}
