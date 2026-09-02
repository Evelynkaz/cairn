// Shared pagination conventions. Every repository that keyset-paginates on
// (created_at, id) must go through this module rather than reimplementing
// its own limit-clamping and cursor codec: memories, episodes and audit
// used to disagree on `limit: 0`, non-finite limits, and empty-string
// cursors, each producing a different raw error or silent behavior — that
// divergence was a real defect, not a style nit.

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export function clampLimit(limit: number | undefined, max: number = MAX_PAGE_LIMIT): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.min(Math.floor(limit), max);
}

// Cursor is base64url of `${ts}:${id}`, the tuple a (created_at, id) DESC
// ORDER BY resumes on: paging must compare the full tuple, not `ts < ?`
// alone, or rows sharing a timestamp are skipped or repeated.
export function encodeCursor(ts: number, id: string): string {
  return Buffer.from(`${ts}:${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, label: string): { ts: number; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep < 0) {
    throw new Error(`malformed ${label} cursor: ${cursor}`);
  }
  const tsPart = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!/^\d+$/.test(tsPart) || id.length === 0) {
    throw new Error(`malformed ${label} cursor: ${cursor}`);
  }
  return { ts: Number(tsPart), id };
}
