import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSecrets } from "./detectors.js";

// All secret values in this file are SYNTHETIC placeholders (repeated
// filler characters, well-known documentation examples, or values built
// from JSON.stringify + base64url at test time). None of them are, or ever
// were, real credentials — a secret-scanner reviewing this repo should not
// be alarmed by anything below.

// ---------------------------------------------------------------------------
// One positive case per detector
// ---------------------------------------------------------------------------

test("aws-access-key-id: AWS docs' own example key", () => {
  const secret = "AKIAIOSFODNN7EXAMPLE"; // the standard AWS documentation placeholder
  const [finding] = detectSecrets(`export AWS_ACCESS_KEY_ID=${secret}`);
  assert.equal(finding?.kind, "aws-access-key-id");
  assert.equal(finding.start, "export AWS_ACCESS_KEY_ID=".length);
  assert.equal(finding.end - finding.start, secret.length);
});

test("aws-secret-access-key: only fires next to an aws_secret_access_key assignment", () => {
  const secret = "fakeSecretfakeSecretfakeSecretfakeSecret"; // 40 chars, synthetic
  assert.equal(secret.length, 40);
  const [finding] = detectSecrets(`aws_secret_access_key = "${secret}"`);
  assert.equal(finding?.kind, "aws-secret-access-key");
  assert.equal(finding.end - finding.start, 40);
});

test("github-token: ghp_ prefix", () => {
  const secret = "ghp_" + "x".repeat(36);
  const [finding] = detectSecrets(`token: ${secret}`);
  assert.equal(finding?.kind, "github-token");
});

test("github-token: github_pat_ prefix", () => {
  const secret = "github_pat_" + "y".repeat(25);
  const [finding] = detectSecrets(`token: ${secret}`);
  assert.equal(finding?.kind, "github-token");
});

test("openai-key: sk- prefix", () => {
  const secret = "sk-" + "abc123XYZ789abc123XYZ789";
  const [finding] = detectSecrets(`OPENAI_API_KEY=${secret}`);
  assert.equal(finding?.kind, "openai-key");
});

test("anthropic-key: sk-ant- prefix", () => {
  const secret = "sk-ant-" + "abc123XYZ789abc123XYZ789";
  const [finding] = detectSecrets(`ANTHROPIC_API_KEY=${secret}`);
  assert.equal(finding?.kind, "anthropic-key");
});

test("slack-token: xoxb- prefix", () => {
  const secret = "xoxb-1234567890-abcdefghij-klmnopqrstuv";
  const [finding] = detectSecrets(`SLACK_BOT_TOKEN=${secret}`);
  assert.equal(finding?.kind, "slack-token");
});

test("google-api-key: AIza + 35 chars", () => {
  const secret = "AIza" + "y".repeat(35);
  const [finding] = detectSecrets(`key=${secret}`);
  assert.equal(finding?.kind, "google-api-key");
});

test("stripe-key: sk_live_ prefix", () => {
  const secret = "sk_live_" + "z".repeat(24);
  const [finding] = detectSecrets(`STRIPE_SECRET_KEY=${secret}`);
  assert.equal(finding?.kind, "stripe-key");
});

test("stripe-key: _test_ variant is still flagged", () => {
  const secret = "sk_test_" + "z".repeat(24);
  const [finding] = detectSecrets(`STRIPE_SECRET_KEY=${secret}`);
  assert.equal(finding?.kind, "stripe-key");
});

function fakeJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "1234567890" })).toString("base64url");
  const signature = "fakeSignaturePart1234567890"; // synthetic
  return `${header}.${payload}.${signature}`;
}

test("jwt: header decodes to JSON with alg", () => {
  const secret = fakeJwt();
  const [finding] = detectSecrets(`Authorization: ${secret}`);
  assert.equal(finding?.kind, "jwt");
});

test("private-key-block: BEGIN/END RSA PRIVATE KEY", () => {
  const secret = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
    "KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n"); // synthetic, not a real key
  const [finding] = detectSecrets(secret);
  assert.equal(finding?.kind, "private-key-block");
  assert.equal(finding.start, 0);
  assert.equal(finding.end, secret.length);
});

test("url-password: only the password span is captured", () => {
  const password = "hunter2Fake";
  const text = `postgres://admin:${password}@localhost:5432/db`;
  const [finding] = detectSecrets(text);
  assert.equal(finding?.kind, "url-password");
  assert.equal(text.slice(finding.start, finding.end), password);
});

test("generic-bearer: Authorization: Bearer <token>", () => {
  const token = "abcdefghij1234567890";
  const text = `Authorization: Bearer ${token}`;
  const [finding] = detectSecrets(text);
  assert.equal(finding?.kind, "generic-bearer");
  assert.equal(text.slice(finding.start, finding.end), token);
});

// ---------------------------------------------------------------------------
// Negative cases: none of these must fire
// ---------------------------------------------------------------------------

test("negative: git SHA", () => {
  assert.deepEqual(detectSecrets("commit 9f8c3d2b1a7e6f5d4c3b2a1908f7e6d5c4b3a291"), []);
});

test("negative: UUID", () => {
  assert.deepEqual(detectSecrets("id: 550e8400-e29b-41d4-a716-446655440000"), []);
});

test("negative: base64 image data URI", () => {
  assert.deepEqual(
    detectSecrets("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA"),
    [],
  );
});

test("negative: long English sentence", () => {
  assert.deepEqual(
    detectSecrets(
      "The quick brown fox jumps over the lazy dog while thinking about how memory systems should behave under load.",
    ),
    [],
  );
});

test("negative: file path with underscores", () => {
  assert.deepEqual(
    detectSecrets("/home/user/projects/aws_secret_access_key_notes.md"),
    [],
  );
});

test("negative: bitcoin-looking address", () => {
  assert.deepEqual(detectSecrets("1BoatSLRHtKNngkdXEeobR76b53LETtpyT"), []);
});

test("negative: bare 'sk-' with nothing after", () => {
  assert.deepEqual(detectSecrets("the prefix sk- means something in this codebase"), []);
});

test("negative: bare 'Bearer' with nothing after", () => {
  assert.deepEqual(detectSecrets("Authorization: Bearer"), []);
});

test("negative: 40-char lowercase hex hash", () => {
  assert.deepEqual(detectSecrets("d41d8cd98f00b204e9800998ecf8427ed41d8cd"), []);
});

// ---------------------------------------------------------------------------
// Preview never leaks the secret
// ---------------------------------------------------------------------------

test("preview never contains the full matched secret", () => {
  const samples = [
    `export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE`,
    `aws_secret_access_key = "fakeSecretfakeSecretfakeSecretfakeSecret"`,
    `token: ghp_${"x".repeat(36)}`,
    `token: github_pat_${"y".repeat(25)}`,
    `OPENAI_API_KEY=sk-abc123XYZ789abc123XYZ789`,
    `ANTHROPIC_API_KEY=sk-ant-abc123XYZ789abc123XYZ789`,
    `SLACK_BOT_TOKEN=xoxb-1234567890-abcdefghij-klmnopqrstuv`,
    `key=AIza${"y".repeat(35)}`,
    `STRIPE_SECRET_KEY=sk_live_${"z".repeat(24)}`,
    `Authorization: ${fakeJwt()}`,
    `postgres://admin:hunter2Fake@localhost:5432/db`,
    `Authorization: Bearer abcdefghij1234567890`,
  ];
  for (const text of samples) {
    for (const finding of detectSecrets(text)) {
      const value = text.slice(finding.start, finding.end);
      assert.ok(
        !finding.preview.includes(value),
        `preview for ${finding.kind} must not contain the full secret`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Overlap handling
// ---------------------------------------------------------------------------

test("overlap: a JWT-looking span inside a private key block yields one finding", () => {
  const embedded = fakeJwt();
  const text = [
    "-----BEGIN RSA PRIVATE KEY-----",
    embedded,
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const findings = detectSecrets(text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "private-key-block");
});

test("overlap: an sk-ant- key is reported once, as anthropic-key not openai-key", () => {
  const secret = "sk-ant-" + "abc123XYZ789abc123XYZ789";
  const findings = detectSecrets(`key=${secret}`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "anthropic-key");
});

// ---------------------------------------------------------------------------
// Multiple findings: adjacent, position 0, position at end
// ---------------------------------------------------------------------------

test("multiple findings splice correctly: adjacent (zero-gap), at start, at end", () => {
  const first = "AKIAIOSFODNN7EXAMPLE"; // position 0
  const pem = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n"); // immediately adjacent to `first`, zero characters between
  const last = "sk_live_" + "z".repeat(24); // ends the string
  const text = first + pem + " " + last;

  const findings = detectSecrets(text);
  assert.equal(findings.length, 3);

  assert.equal(findings[0]?.kind, "aws-access-key-id");
  assert.equal(findings[0]?.start, 0);
  assert.equal(findings[0]?.end, first.length);

  assert.equal(findings[1]?.kind, "private-key-block");
  assert.equal(findings[1]?.start, first.length); // touches finding[0], zero gap
  assert.equal(findings[1]?.end, first.length + pem.length);

  assert.equal(findings[2]?.kind, "stripe-key");
  assert.equal(findings[2]?.end, text.length);
});

// ---------------------------------------------------------------------------
// maxFindings bounds pathological input
// ---------------------------------------------------------------------------

test("maxFindings bounds a pathological input and returns promptly", () => {
  const tokens = Array.from({ length: 10000 }, (_, i) => `bearer token${i}1234567890`);
  const text = tokens.join(" ");
  const start = Date.now();
  const findings = detectSecrets(text);
  const elapsed = Date.now() - start;
  assert.ok(findings.length <= 100);
  assert.ok(elapsed < 5000, `detectSecrets took too long: ${elapsed}ms`);
});

test("maxFindings option is respected", () => {
  const tokens = Array.from({ length: 50 }, (_, i) => `bearer token${i}1234567890`);
  const findings = detectSecrets(tokens.join(" "), { maxFindings: 5 });
  assert.equal(findings.length, 5);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("determinism: same input twice, identical output", () => {
  const text = `Authorization: Bearer abcdefghij1234567890 and AKIAIOSFODNN7EXAMPLE`;
  assert.deepEqual(detectSecrets(text), detectSecrets(text));
});
