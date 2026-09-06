import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, DEFAULT_PRIVACY_MODE } from "./redact.js";

// Synthetic secrets only — see the comment at the top of detectors.test.ts.

test("off: text unchanged, no findings, not blocked", () => {
  const text = "my AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE is right here";
  const result = redactText(text, "off");
  assert.equal(result.text, text);
  assert.deepEqual(result.findings, []);
  assert.equal(result.blocked, false);
});

test("on: replaces the finding with a kind marker", () => {
  const secret = "AKIAIOSFODNN7EXAMPLE";
  const result = redactText(`key=${secret}`, "on");
  assert.equal(result.text, "key=[redacted:aws-access-key-id]");
  assert.equal(result.blocked, false);
  assert.equal(result.findings.length, 1);
});

test("on: no findings leaves text unchanged", () => {
  const text = "nothing secret in here at all";
  const result = redactText(text, "on");
  assert.equal(result.text, text);
  assert.deepEqual(result.findings, []);
});

test("strict: original text untouched, blocked true when a secret is present", () => {
  const secret = "AKIAIOSFODNN7EXAMPLE";
  const text = `key=${secret}`;
  const result = redactText(text, "strict");
  assert.equal(result.text, text); // byte-identical
  assert.equal(result.blocked, true);
  assert.equal(result.findings.length, 1);
});

test("strict: not blocked when no secret is present", () => {
  const text = "nothing secret in here at all";
  const result = redactText(text, "strict");
  assert.equal(result.text, text);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.findings, []);
});

test("splicing: multiple, adjacent, and boundary findings all replace correctly", () => {
  const first = "AKIAIOSFODNN7EXAMPLE"; // position 0
  const pem = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n"); // immediately adjacent to `first`, zero characters between
  const last = "sk_live_" + "z".repeat(24); // ends the string
  const text = first + pem + " " + last;

  const result = redactText(text, "on");
  assert.equal(
    result.text,
    "[redacted:aws-access-key-id][redacted:private-key-block] [redacted:stripe-key]",
  );
  // No marker text ends up nested inside another marker.
  assert.equal((result.text.match(/\[redacted:/g) ?? []).length, 3);
});

test("determinism: same input, same mode, identical output", () => {
  const text = "Authorization: Bearer abcdefghij1234567890 and AKIAIOSFODNN7EXAMPLE";
  assert.deepEqual(redactText(text, "on"), redactText(text, "on"));
  assert.deepEqual(redactText(text, "strict"), redactText(text, "strict"));
});

test("DEFAULT_PRIVACY_MODE is 'on'", () => {
  assert.equal(DEFAULT_PRIVACY_MODE, "on");
});

// ---------------------------------------------------------------------------
// CRITICAL-1: the finding cap must bound reporting, never redaction
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CRITICAL-1: env-secret false positives must never rewrite the episode
// ---------------------------------------------------------------------------

test("CRITICAL-1: realistic prose is stored byte-identical under redaction (the episode is unrecoverable if this fails)", () => {
  const prose = [
    "Password: use the one stored in 1Password",
    "The staging secret: rotate it every 90 days",
    "API_KEY: ask Dana for it",
    "my_secret: tell nobody",
    "GitHub PAT credentials: stored in the team vault",
    "auth_token: TODO",
    "TOKEN=see the runbook",
  ];
  for (const text of prose) {
    const result = redactText(text, "on");
    assert.equal(result.text, text, `must not rewrite: ${text}`);
    assert.deepEqual(result.findings, []);
  }
});

// ---------------------------------------------------------------------------
// Recovered real-secret shapes (independent review of the CRITICAL-1 fix):
// all five must be fully redacted, with no raw value surviving.
// ---------------------------------------------------------------------------

test("recovered: all five real secret shapes are fully redacted, no raw value survives", () => {
  const cases: Array<[string, string]> = [
    ["export DB_PASSWORD=sup3rs3cretvalue!", "sup3rs3cretvalue!"],
    ["password: SomeRealSecret123", "SomeRealSecret123"],
    ["DB_PASSWORD: Tr0ub4dor3xyz", "Tr0ub4dor3xyz"],
    ["DB_PASSWORD=Tr0ub4dor3", "Tr0ub4dor3"],
    ["API_KEY=abcdefghijklmnop", "abcdefghijklmnop"],
  ];
  for (const [text, value] of cases) {
    const result = redactText(text, "on");
    assert.ok(!result.text.includes(value), `raw value must not survive redaction of: ${text}`);
    assert.ok(result.text.includes("[redacted:env-secret]"), `must redact: ${text}`);
  }
});

test("CRITICAL-1: 150 secrets in one input are all redacted, none survive raw in the output", () => {
  const keys = Array.from({ length: 150 }, (_, i) => `AKIA${String(i).padStart(16, "0")}`);
  const text = keys.join(" ");
  const result = redactText(text, "on");
  assert.equal(result.findings.length, 150);
  for (const key of keys) {
    assert.ok(!result.text.includes(key), `raw key ${key} must not survive redaction`);
  }
  assert.equal((result.text.match(/\[redacted:aws-access-key-id\]/g) ?? []).length, 150);
});
