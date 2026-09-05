// Pure, dependency-free secret detection (BUILD_BRIEF §10). No I/O, no
// database, no network — this module only looks at the string it is given.
// Deliberately kept pure so it can be exhaustively unit tested: this is the
// code that decides whether a user's secret leaves their keyboard intact.

export type SecretKind =
  | "aws-access-key-id"
  | "aws-secret-access-key"
  | "aws-session-token"
  | "github-token"
  | "gitlab-token"
  | "openai-key"
  | "anthropic-key"
  | "slack-token"
  | "slack-webhook"
  | "google-api-key"
  | "stripe-key"
  | "jwt"
  | "private-key-block"
  | "putty-private-key"
  | "url-password"
  | "generic-bearer"
  | "npm-token"
  | "huggingface-token"
  | "sendgrid-key"
  | "pypi-token"
  | "env-secret";

export interface Finding {
  kind: SecretKind;
  start: number;
  end: number;
  // A MASKED excerpt of the matched span — never the full value. A finding
  // is a thing we log, show in a dashboard, and put in error messages; if it
  // carried the secret we would have moved the leak rather than stopped it.
  preview: string;
}

// Only bounds what detectSecrets RETURNS/callers display. It must never
// bound what gets redacted: an unreturned finding whose span was never
// spliced out is a secret stored raw with no signal that anything was
// wrong. See the accepted-candidates loop below, which has no cap.
const DEFAULT_MAX_FINDINGS = Infinity;

interface Candidate {
  kind: SecretKind;
  start: number;
  end: number;
  // Lower priority wins ties in length: earlier (more specific) detectors
  // beat later (more generic) ones when two candidates cover the exact same
  // span (e.g. an Anthropic key also satisfies the generic OpenAI shape).
  priority: number;
}

// Masks a matched span for display/persistence. Never reveals trailing
// characters (a trailing slice of a short value can be most of it — see the
// CVE-shaped bug this replaced). Below ~20 chars the value is short enough
// that even a 4-char prefix is a large fraction of it, so it is fully
// masked with a FIXED-length run of asterisks (fixed so the preview itself
// does not leak the value's true length). At or above ~20 chars, a leading
// prefix is shown so a user can tell WHICH token this was (e.g. "AKIA",
// "ghp_") — never to help identify the value. For kinds where even the
// prefix is entropy rather than a type signal, the value is masked
// entirely regardless of length.
// A kind belongs here when its first characters are entropy; it does NOT
// belong here when its first characters are a fixed, publicly known type
// marker (e.g. "AKIA", "ghp_", "glpat-", "sk-ant-").
export const FULLY_MASKED_KINDS: ReadonlySet<SecretKind> = new Set([
  "url-password",
  "generic-bearer",
  "env-secret",
  "aws-secret-access-key",
  "aws-session-token",
]);
const MASK = "*".repeat(8);

function maskPreview(value: string, kind: SecretKind): string {
  if (FULLY_MASKED_KINDS.has(kind)) return MASK;
  if (value.length < 20) return MASK;
  return `${value.slice(0, 4)}${MASK}`;
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

// Blank-line boundaries, for detectors that redact "from a header to the
// end of the block" when there is no well-formed closing delimiter to
// anchor on. Setting `lastIndex` and re-`exec`-ing per header (rather than
// `text.slice(from)`) avoids the copy, but a hostile input with NO blank
// line at all (e.g. thousands of bare "-----BEGIN ... PRIVATE KEY-----"
// headers back to back) still forces each such scan to run to the end of
// the text, which is O(n) per header and therefore O(n^2) overall — this
// is exactly the shape CRITICAL-2 measured. So instead every blank-line
// boundary is found ONCE per `text` (a single O(n) pass, in order), and
// each header does an O(log n) binary search into that sorted list.
function findBlockBoundaries(text: string): number[] {
  const boundaries: number[] = [];
  for (const match of text.matchAll(/\r?\n[ \t]*\r?\n/g)) {
    boundaries.push(match.index);
  }
  return boundaries;
}

function endOfBlock(boundaries: readonly number[], text: string, from: number): number {
  let lo = 0;
  let hi = boundaries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((boundaries[mid] as number) < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < boundaries.length ? (boundaries[lo] as number) : text.length;
}

// AWS access key id: AKIA (long-term) or ASIA (temporary/STS) + 16 uppercase
// alphanumeric characters. Does NOT match lowercase or shorter look-alikes.
const AWS_ACCESS_KEY_ID = /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/gd;

// AWS secret access key: a 40-char base64-ish string is far too common on
// its own, so this only fires when it appears as the value of an
// `aws_secret_access_key`-style assignment. Deliberately does NOT match a
// bare 40-char string anywhere else in the text. Key name and value may
// each optionally be quoted, so both `aws_secret_access_key=VALUE` and the
// JSON/YAML/tfvars `"aws_secret_access_key": "VALUE"` form are covered.
const AWS_SECRET_ACCESS_KEY =
  /["']?aws_secret_access_key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gid;

// AWS session token: like the secret key above, only fires next to its own
// assignment (session tokens have no fixed prefix and are otherwise
// indistinguishable from arbitrary base64). Length is variable (real tokens
// run to several hundred characters), so this only sets a floor.
const AWS_SESSION_TOKEN =
  /["']?aws_session_token["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{20,})["']?/gid;

// GitHub fine-grained/classic tokens: ghp_/gho_/ghu_/ghs_/ghr_ prefixes each
// followed by 36+ alphanumerics.
const GITHUB_TOKEN = /(?<![A-Za-z0-9_])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}(?![A-Za-z0-9_])/gd;

// GitHub fine-grained PAT: the github_pat_ prefix followed by a long
// alphanumeric/underscore body.
const GITHUB_PAT = /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}(?![A-Za-z0-9_])/gd;

// GitLab personal access token: glpat- prefix + a long alphanumeric/dash
// body. Fixed prefix, effectively zero false-positive risk.
const GITLAB_TOKEN = /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/gd;

// Anthropic key: sk-ant- prefix. Checked BEFORE the generic OpenAI sk-
// pattern so an Anthropic key is not also (mis)labelled as an OpenAI key.
const ANTHROPIC_KEY = /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/gd;

// OpenAI key: sk- or sk-proj- prefix. Requires a long tail so the bare
// literal "sk-" never matches on its own.
const OPENAI_KEY = /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/gd;

// Slack token: xoxb-/xoxa-/xoxp-/xoxr-/xoxs-/xoxe- prefix + a dash-delimited
// body.
const SLACK_TOKEN = /(?<![A-Za-z0-9_-])xox[baprse]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9_-])/gd;

// Slack app-level token: xapp- prefix + a dash-delimited body.
const SLACK_XAPP_TOKEN = /(?<![A-Za-z0-9_-])xapp-[A-Za-z0-9-]{10,}(?![A-Za-z0-9_-])/gd;

// Slack incoming webhook: a fixed, distinctive URL shape. Posting to it is
// equivalent to holding the credential.
const SLACK_WEBHOOK =
  /(?<![A-Za-z0-9._-])https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+(?![A-Za-z0-9])/gd;

// Google API key: AIza + 35 alphanumeric/underscore/dash characters (the
// fixed length Google issues them at).
const GOOGLE_API_KEY = /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/gd;

// Stripe key: sk_/rk_/pk_ + live/test + a long alphanumeric body. A test key
// is still a credential, so both live and test variants are flagged.
const STRIPE_KEY = /(?<![A-Za-z0-9_-])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}(?![A-Za-z0-9_-])/gd;

// npm publish token: npm_ prefix + a long alphanumeric body.
const NPM_TOKEN = /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{20,}(?![A-Za-z0-9_])/gd;

// HuggingFace token: hf_ prefix + a long alphanumeric body.
const HUGGINGFACE_TOKEN = /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{20,}(?![A-Za-z0-9_])/gd;

// SendGrid API key: SG. + two dot-separated base64url-ish segments.
const SENDGRID_KEY = /(?<![A-Za-z0-9._-])SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/gd;

// PyPI upload token: pypi- prefix + a long alphanumeric/dash/underscore body.
const PYPI_TOKEN = /(?<![A-Za-z0-9_-])pypi-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/gd;

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
// the matching -----END ... PRIVATE KEY----- (same label on both ends,
// matched case-insensitively), including the body.
//
// This used to be one lazy regex (`[\s\S]*?` between BEGIN and END). That is
// fine when an END exists nearby, but when it does NOT — many repeated bare
// BEGIN headers, which is exactly the hostile-archive shape CRITICAL-2
// measured — the lazy quantifier scans to the end of the text and fails,
// once per BEGIN, which is O(n) per header and O(n^2) overall (measured:
// ~6.3s on its own for 20,000 repeated headers, independent of the two
// scans named below). So BEGIN and END are now found in two separate
// linear passes (neither has unbounded backtracking) and paired up by
// label via a map + binary search, which is O(n log n) total.
const PRIVATE_KEY_HEADER = /-----BEGIN ([A-Za-z0-9 ]*PRIVATE KEY)-----/gid;
const PRIVATE_KEY_END = /-----END ([A-Za-z0-9 ]*PRIVATE KEY)-----/gid;

// Binary search over `spans` (start-ordered, since matchAll yields matches
// in text order): the first span whose start is >= `pos`, or null. O(log n)
// per lookup instead of a linear scan — load-bearing once the finding cap
// was removed (CRITICAL-2), since a pathological input can produce many
// thousands of candidates.
function firstAtOrAfter(
  spans: ReadonlyArray<[number, number]>,
  pos: number,
): [number, number] | null {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((spans[mid] as [number, number])[0] < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo < spans.length ? (spans[lo] as [number, number]) : null;
}

// Binary search over `fullSpans` (already start-ordered): finds the span
// with the greatest start <= pos, then checks whether pos falls inside it.
// O(log n) per header instead of the O(n) `Array#some` scan this replaced
// (load-bearing once the finding cap was removed — see CRITICAL-2).
function coveredByFullSpan(fullSpans: ReadonlyArray<[number, number]>, pos: number): boolean {
  let lo = 0;
  let hi = fullSpans.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const span = fullSpans[mid] as [number, number];
    if (span[0] <= pos) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate === -1) return false;
  const [, fEnd] = fullSpans[candidate] as [number, number];
  return pos < fEnd;
}

function collectPrivateKeyBlocks(text: string): Candidate[] {
  const out: Candidate[] = [];
  const fullSpans: Array<[number, number]> = [];
  const headerMatches = [...text.matchAll(PRIVATE_KEY_HEADER)];

  if (headerMatches.length > 0) {
    // Group END occurrences by lowercased label; each per-label list stays
    // in text order (start-ascending), which is what firstAtOrAfter needs.
    const endsByLabel = new Map<string, Array<[number, number]>>();
    for (const match of text.matchAll(PRIVATE_KEY_END)) {
      const label = match[1];
      const span = groupSpan(match, 0);
      if (label === undefined || span === null) continue;
      const key = label.toLowerCase();
      const list = endsByLabel.get(key);
      if (list) list.push(span);
      else endsByLabel.set(key, [span]);
    }

    // Headers already inside a full span found for an earlier header are
    // skipped here too, same as the original regex's global-match advance:
    // a BEGIN nested inside an already-consumed block never starts a new
    // full-block search of its own.
    let cursor = 0;
    for (const match of headerMatches) {
      const label = match[1];
      const span = groupSpan(match, 0);
      if (label === undefined || span === null) continue;
      const [headerStart, headerEnd] = span;
      if (headerStart < cursor) continue;
      const ends = endsByLabel.get(label.toLowerCase());
      const endSpan = ends ? firstAtOrAfter(ends, headerEnd) : null;
      if (endSpan === null) continue;
      const fullSpan: [number, number] = [headerStart, endSpan[1]];
      out.push({ kind: "private-key-block", start: fullSpan[0], end: fullSpan[1], priority: -1 });
      fullSpans.push(fullSpan);
      cursor = fullSpan[1];
    }
  }

  const boundaries = headerMatches.length > 0 ? findBlockBoundaries(text) : [];
  for (const match of headerMatches) {
    const span = groupSpan(match, 0);
    if (span === null) continue;
    const [headerStart, headerEnd] = span;
    if (coveredByFullSpan(fullSpans, headerStart)) continue;
    out.push({
      kind: "private-key-block",
      start: headerStart,
      end: endOfBlock(boundaries, text, headerEnd),
      priority: -1,
    });
  }
  return out;
}

// PuTTY private key file: PuTTY-User-Key-File-<version>: header through the
// end of the block (PuTTY's own format has no closing delimiter, only a
// trailing blank line or end of input).
const PUTTY_HEADER = /PuTTY-User-Key-File-\d+:/gid;

function collectPutty(text: string): Candidate[] {
  const out: Candidate[] = [];
  const headerMatches = [...text.matchAll(PUTTY_HEADER)];
  const boundaries = headerMatches.length > 0 ? findBlockBoundaries(text) : [];
  for (const match of headerMatches) {
    const span = groupSpan(match, 0);
    if (span === null) continue;
    out.push({
      kind: "putty-private-key",
      start: span[0],
      end: endOfBlock(boundaries, text, span[1]),
      priority: 12,
    });
  }
  return out;
}

// URL password: scheme://[user]:password@host. The user part is optional
// (redis://:password@host is a common shape) and the password may itself
// contain '/' (anchored on the '@' rather than excluding '/'), so only the
// scheme, user and host are excluded from the captured span. http/https are
// skipped: inline credentials in an http(s) URL are overwhelmingly example
// text ("https://user:guide@example.com"), and flagging them trades a real
// false-positive class for very little true-positive coverage.
const URL_PASSWORD =
  /(?<![A-Za-z0-9+.-])(?!https?:\/\/)[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@]*:([^\s@]+)@/gd;

// Generic bearer token: "Authorization: Bearer <token>" or bare
// "bearer <token>", case-insensitive. Only the token itself is captured.
// Requires a plausible token length so bare "Bearer" with nothing after it
// never matches. Charset includes the full base64 alphabet (+, /) and the
// base64url tilde extension, with a boundary that excludes all of them, so
// a base64 bearer token is never truncated at its first '+' or '/' (a
// partial match is worse than none: it still records a finding, so a
// caller believes the secret was fully handled while its tail survives).
const GENERIC_BEARER = /bearer\s+([A-Za-z0-9\-_.+/=~]{10,})(?![A-Za-z0-9_\-.+/=~])/gid;

// .env-style assignment: KEY=value, where KEY's name contains one of a
// fixed list of secret-signalling substrings. Only the VALUE is redacted.
// A pasted .env file is the single most likely way a secret reaches this
// store (BUILD_BRIEF §10), but an earlier version of this detector also
// mangled ordinary prose (a "Password:" or "secret:" mid-sentence is
// overwhelmingly a person talking, not an assignment — see the module's own
// precision-over-recall doctrine above). It now requires ALL of:
//   (a) line-anchored: the key must start the line (only leading
//       whitespace before it), so a key name mid-sentence never qualifies;
//   (b) '=' only, never ':' — a colon is overwhelmingly prose punctuation
//       ("Password: use the one stored in 1Password"), an equals sign is
//       assignment;
//   (c) a value of at least 12 characters containing a digit or a
//       non-alphanumeric character, so a plain-English reply ("TOKEN=see
//       the runbook") is not mistaken for a value.
// Measured: this kills all of "Password: use the one stored in 1Password",
// "The staging secret: rotate it every 90 days", "API_KEY: ask Dana for
// it", "my_secret: tell nobody", "GitHub PAT credentials: stored in the
// team vault", "auth_token: TODO" and "TOKEN=see the runbook" — see
// detectors.test.ts — while still catching genuine .env shapes.
const ENV_KEY = /^[ \t]*([A-Za-z][A-Za-z0-9_]{0,63})[ \t]*=[ \t]*["']?([^\s"'#]+)["']?/gmd;
const ENV_SECRET_NAME = /PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIALS/i;
const ENV_VALUE_MIN_LENGTH = 12;
const ENV_VALUE_HAS_SIGNAL = /[0-9]|[^A-Za-z0-9]/;

function collectEnvAssignments(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const match of text.matchAll(ENV_KEY)) {
    const key = match[1];
    if (key === undefined || !ENV_SECRET_NAME.test(key)) continue;
    const span = groupSpan(match, 2);
    if (span === null) continue;
    const [start, end] = span;
    if (end <= start) continue;
    const value = text.slice(start, end);
    if (value.length < ENV_VALUE_MIN_LENGTH) continue;
    if (!ENV_VALUE_HAS_SIGNAL.test(value)) continue;
    out.push({ kind: "env-secret", start, end, priority: 20 });
  }
  return out;
}

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
    ...collectPrivateKeyBlocks(text),
    ...collectSimple(text, "url-password", 9, URL_PASSWORD, 1),
    ...collectSimple(text, "generic-bearer", 10, GENERIC_BEARER, 1),
    ...collectSimple(text, "gitlab-token", 11, GITLAB_TOKEN),
    ...collectPutty(text),
    ...collectSimple(text, "slack-token", 13, SLACK_XAPP_TOKEN),
    ...collectSimple(text, "slack-webhook", 13, SLACK_WEBHOOK),
    ...collectSimple(text, "npm-token", 14, NPM_TOKEN),
    ...collectSimple(text, "huggingface-token", 15, HUGGINGFACE_TOKEN),
    ...collectSimple(text, "sendgrid-key", 16, SENDGRID_KEY),
    ...collectSimple(text, "pypi-token", 17, PYPI_TOKEN),
    ...collectSimple(text, "aws-session-token", 18, AWS_SESSION_TOKEN, 1),
    ...collectEnvAssignments(text),
  ];
}

// Resolves overlaps in `sorted` (already ordered by preference: longer
// match first, ties broken by detector specificity then position) into a
// disjoint set, kept sorted by `start` throughout via binary-search
// insertion. This is O(n log n) rather than the naive O(n^2) "compare every
// candidate against every previously accepted one" — load-bearing once
// CRITICAL-1 removed the early cap, since a pathological input can produce
// many thousands of non-overlapping candidates and this runs on the write
// path.
function resolveOverlaps(sorted: readonly Candidate[]): Candidate[] {
  const accepted: Candidate[] = [];
  for (const candidate of sorted) {
    // Binary search for the first accepted interval whose start is >=
    // candidate.start.
    let lo = 0;
    let hi = accepted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((accepted[mid] as Candidate).start < candidate.start) lo = mid + 1;
      else hi = mid;
    }
    const before = lo > 0 ? accepted[lo - 1] : undefined;
    const after = lo < accepted.length ? accepted[lo] : undefined;
    const overlapsBefore = before !== undefined && before.end > candidate.start;
    const overlapsAfter = after !== undefined && after.start < candidate.end;
    if (overlapsBefore || overlapsAfter) continue;
    accepted.splice(lo, 0, candidate);
  }
  return accepted;
}

/**
 * Detects high-confidence secret shapes in `text`. Precision over recall,
 * deliberately: a false positive mangles a user's own note, and for a
 * memory product that is worse than a miss — a missed token is a risk the
 * user may already be managing, a corrupted memory is the product breaking
 * its core promise. No entropy heuristics; only the specific shapes above.
 *
 * Every non-overlapping finding is detected and returned unconditionally —
 * `maxFindings` (default: unbounded) only trims the size of the array this
 * function RETURNS, for a caller that wants to bound what it displays or
 * logs. It must never be used to bound what gets redacted: a finding a
 * caller never sees but that also never got spliced out is a secret stored
 * raw with no signal anything went wrong (this was CRITICAL-1). Callers
 * that redact text must always use the FULL, unsliced return.
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

  const accepted = resolveOverlaps(candidates);

  return accepted.slice(0, maxFindings).map((c) => ({
    kind: c.kind,
    start: c.start,
    end: c.end,
    preview: maskPreview(text.slice(c.start, c.end), c.kind),
  }));
}
