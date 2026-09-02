import { createHash } from "node:crypto";

// Bumping this version changes every future content_hash, which is
// deliberate: if the normalization rules ever change, hashes must diverge
// rather than silently collide with rows written under the old rules.
export const CONTENT_HASH_VERSION = "v1";

export function normalizeForHash(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

// Hashes the text only — scope is intentionally excluded; uniqueness across
// scopes is enforced by a composite (scope, content_hash) index.
export function contentHash(text: string): string {
  const payload = `${CONTENT_HASH_VERSION}\n${normalizeForHash(text)}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
