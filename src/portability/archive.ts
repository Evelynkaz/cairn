// Export/import archive format for BUILD_BRIEF §10/§16 milestone 10: "one
// ZIP + SHA256 manifest". Built entirely on top of ./zip.ts's ZIP
// reader/writer -- this module owns only the Cairn-specific layout inside
// that ZIP, never the ZIP bytes themselves.
//
// The layout is deliberately plain and inspectable (§1 sells portability as
// something the user OWNS): manifest.json names a format version, an
// export timestamp, counts, and a SHA256 checksum for every other entry;
// memories.jsonl and episodes.jsonl are one JSON object per line (not one
// giant array) so they stream and stay diffable; README.txt explains all of
// this to a user who opens the archive with an ordinary unzip tool.

import { createHash } from "node:crypto";
import { DEFAULT_SCOPE } from "../storage/index.js";
import type { Store, CallContext } from "../storage/index.js";
import { readZip, writeZip } from "./zip.js";
import type { ZipEntry } from "./zip.js";

export interface ExportOptions {
  scope?: string;
  includeDeleted?: boolean;
  includeSuperseded?: boolean;
}

export interface ExportResult {
  archive: Buffer;
  memories: number;
  episodes: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  memories: number;
  // Same shape as the memory fields above, one level down: episodes are a
  // separate archive entry with their own import outcome, since a memory
  // and its source episode can be skipped independently (e.g. the episode
  // was already live from a prior import but the memory referencing it was
  // pruned by a scope filter, or vice versa).
  episodesImported: number;
  episodesSkipped: number;
  episodes: number;
}

/** Thrown for anything wrong with the ARCHIVE's contents -- corrupted,
 * tampered with, or an unsupported/future format -- as opposed to a bug in
 * this module. Mirrors ZipFormatError's role one layer up. */
export class ArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveFormatError";
  }
}

const FORMAT_VERSION = 1;

// A distinct, recognizable sourceClient for export/import's own store
// calls, same pattern as the dashboard's own CTX (dashboard/api.ts) --
// this is administrative traffic issuing store calls on the user's behalf,
// not a connected MCP client, but it still goes through gate()/audit like
// everything else so it shows up honestly in the access log.
const CTX: CallContext = { sourceClient: "cairn-portability" };

// Page size for streaming reads out of the store during export -- keeps
// exportArchive from ever holding the whole store in memory, per the
// "paginate when reading from the store" requirement. store.list/episodes
// clamp this further internally (paging.ts's clampLimit) if it's too high.
const EXPORT_PAGE_SIZE = 500;

// Caps the number of JSONL lines importArchive will parse, bounding the
// work a hostile/corrupt archive can demand. Matches zip.ts's own
// MAX_ENTRIES, since a memory-per-line archive built by this module never
// has more lines than a legitimate archive has zip entries worth of data.
const MAX_LINES = 100_000;

interface MemoryRecord {
  id: string;
  text: string;
  scope: string;
  tags: string[];
  importance: number;
  sourceClient: string | null;
  createdAt: number;
  updatedAt: number;
  validFrom: number;
  validUntil: number | null;
  supersededBy: string | null;
  deletedAt: number | null;
  redacted: boolean;
  episodeId: string | null;
}

interface EpisodeRecord {
  id: string;
  content: string;
  scope: string;
  sourceClient: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function findEntry(entries: readonly ZipEntry[], name: string): ZipEntry | undefined {
  return entries.find((e) => e.name === name);
}

const README = `This is a Cairn memory export.

It is an ordinary ZIP file containing plain, line-delimited JSON -- nothing
proprietary or binary. You can inspect it with any unzip tool, a text
editor, jq, or grep:

  manifest.json   format version, export timestamp, counts, and a SHA256
                  checksum for every other file in this archive, so a
                  corrupted or tampered-with archive can be detected before
                  anything is imported from it
  memories.jsonl  one memory per line: its text, scope, tags, importance,
                  and timestamps
  episodes.jsonl  one episode per line -- the original source text each
                  memory was written from, kept for provenance

Your memory should always be yours to read, move, and delete. That is what
this file is for.
`;

export function exportArchive(store: Store, options: ExportOptions = {}): ExportResult {
  const includeDeleted = options.includeDeleted ?? false;
  const includeSuperseded = options.includeSuperseded ?? false;

  const memoryLines: string[] = [];
  let memories = 0;
  {
    let cursor: string | null = null;
    for (;;) {
      const page = store.list(
        { scope: options.scope, includeDeleted, includeSuperseded, cursor, limit: EXPORT_PAGE_SIZE },
        CTX,
      );
      for (const m of page.items) {
        const record: MemoryRecord = {
          id: m.id,
          text: m.text,
          scope: m.scope,
          tags: m.tags,
          importance: m.importance,
          sourceClient: m.sourceClient,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
          validFrom: m.validFrom,
          validUntil: m.validUntil,
          supersededBy: m.supersededBy,
          deletedAt: m.deletedAt,
          redacted: m.redacted,
          episodeId: m.episodeId,
        };
        memoryLines.push(JSON.stringify(record));
        memories += 1;
      }
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
  }

  const episodeLines: string[] = [];
  let episodes = 0;
  {
    let cursor: string | null = null;
    for (;;) {
      const page = store.episodes({ scope: options.scope, cursor, limit: EXPORT_PAGE_SIZE }, CTX);
      for (const e of page.items) {
        const record: EpisodeRecord = {
          id: e.id,
          content: e.content,
          scope: e.scope,
          sourceClient: e.sourceClient,
          metadata: e.metadata,
          createdAt: e.createdAt,
        };
        episodeLines.push(JSON.stringify(record));
        episodes += 1;
      }
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
  }

  // Trailing newline after each line (not a leading one), matching the
  // usual JSONL convention -- one JSON object per line, and the file still
  // reads correctly with tools that skip the final blank "line".
  const memoriesBuf = Buffer.from(memoryLines.map((l) => `${l}\n`).join(""), "utf8");
  const episodesBuf = Buffer.from(episodeLines.map((l) => `${l}\n`).join(""), "utf8");
  const readmeBuf = Buffer.from(README, "utf8");

  const manifest = {
    formatVersion: FORMAT_VERSION,
    exportedAt: Date.now(),
    counts: { memories, episodes },
    entries: {
      "memories.jsonl": { sha256: sha256(memoriesBuf), bytes: memoriesBuf.length },
      "episodes.jsonl": { sha256: sha256(episodesBuf), bytes: episodesBuf.length },
      "README.txt": { sha256: sha256(readmeBuf), bytes: readmeBuf.length },
    },
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");

  const entries: ZipEntry[] = [
    { name: "manifest.json", data: manifestBuf },
    { name: "memories.jsonl", data: memoriesBuf },
    { name: "episodes.jsonl", data: episodesBuf },
    { name: "README.txt", data: readmeBuf },
  ];

  return { archive: writeZip(entries), memories, episodes };
}

interface RawEpisodeLine {
  id?: unknown;
  content?: unknown;
  scope?: unknown;
  sourceClient?: unknown;
  metadata?: unknown;
  createdAt?: unknown;
}

interface RawMemoryLine {
  id?: unknown;
  text?: unknown;
  scope?: unknown;
  tags?: unknown;
  importance?: unknown;
  sourceClient?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  validFrom?: unknown;
  validUntil?: unknown;
  supersededBy?: unknown;
  deletedAt?: unknown;
  redacted?: unknown;
  episodeId?: unknown;
}

// Splits JSONL content into lines without a trailing empty entry for the
// final "\n" every file written by exportArchive ends with. An archive
// hand-edited to drop that final newline still parses fine either way.
function splitLines(data: Buffer): string[] {
  const text = data.toString("utf8");
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

// Parses and validates memories.jsonl. Treats the archive as hostile input:
// a cap on total lines, and any malformed line -- bad JSON, or missing the
// required id/text fields -- refuses the WHOLE file rather than silently
// dropping that one memory. The error names the file and line number but
// never echoes the line's content, which is memory text and may contain
// secrets.
function parseMemoryLines(data: Buffer, fileName: string): MemoryRecord[] {
  const lines = splitLines(data);
  if (lines.length > MAX_LINES) {
    throw new ArchiveFormatError(`${fileName} has ${lines.length} lines, exceeding the cap of ${MAX_LINES}`);
  }

  const records: MemoryRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      throw new ArchiveFormatError(`${fileName}:${lineNumber}: malformed JSON`);
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new ArchiveFormatError(`${fileName}:${lineNumber}: not a JSON object`);
    }
    const r = parsed as RawMemoryLine;
    if (typeof r.id !== "string" || typeof r.text !== "string") {
      throw new ArchiveFormatError(`${fileName}:${lineNumber}: missing required "id" or "text" field`);
    }
    records.push({
      id: r.id,
      text: r.text,
      scope: typeof r.scope === "string" ? r.scope : DEFAULT_SCOPE,
      tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
      importance: typeof r.importance === "number" ? r.importance : 0.5,
      sourceClient: typeof r.sourceClient === "string" ? r.sourceClient : null,
      createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
      validFrom: typeof r.validFrom === "number" ? r.validFrom : 0,
      validUntil: typeof r.validUntil === "number" ? r.validUntil : null,
      supersededBy: typeof r.supersededBy === "string" ? r.supersededBy : null,
      deletedAt: typeof r.deletedAt === "number" ? r.deletedAt : null,
      redacted: r.redacted === true,
      episodeId: typeof r.episodeId === "string" ? r.episodeId : null,
    });
  }
  return records;
}

// Parses and validates episodes.jsonl. Same hostile-input treatment as
// parseMemoryLines: a cap on total lines, and any malformed line refuses the
// WHOLE file rather than silently dropping that one episode. The error
// names the file and line number but never echoes the line's content, which
// is episode content and may contain secrets.
function parseEpisodeLines(data: Buffer, fileName: string): EpisodeRecord[] {
  const lines = splitLines(data);
  if (lines.length > MAX_LINES) {
    throw new ArchiveFormatError(`${fileName} has ${lines.length} lines, exceeding the cap of ${MAX_LINES}`);
  }

  const records: EpisodeRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      throw new ArchiveFormatError(`${fileName}:${lineNumber}: malformed JSON`);
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new ArchiveFormatError(`${fileName}:${lineNumber}: not a JSON object`);
    }
    const r = parsed as RawEpisodeLine;
    if (typeof r.id !== "string" || typeof r.content !== "string") {
      throw new ArchiveFormatError(`${fileName}:${lineNumber}: missing required "id" or "content" field`);
    }
    records.push({
      id: r.id,
      content: r.content,
      scope: typeof r.scope === "string" ? r.scope : DEFAULT_SCOPE,
      sourceClient: typeof r.sourceClient === "string" ? r.sourceClient : null,
      metadata:
        typeof r.metadata === "object" && r.metadata !== null ? (r.metadata as Record<string, unknown>) : {},
      createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    });
  }
  return records;
}

export function importArchive(store: Store, archive: Buffer): ImportResult {
  let entries: ZipEntry[];
  try {
    entries = readZip(archive);
  } catch (err) {
    throw new ArchiveFormatError(`not a valid Cairn archive: ${err instanceof Error ? err.message : String(err)}`);
  }

  const manifestEntry = findEntry(entries, "manifest.json");
  if (!manifestEntry) {
    throw new ArchiveFormatError("archive is missing manifest.json");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  } catch {
    throw new ArchiveFormatError("manifest.json is not valid JSON");
  }
  if (typeof manifest !== "object" || manifest === null) {
    throw new ArchiveFormatError("manifest.json is not a JSON object");
  }
  const m = manifest as { formatVersion?: unknown; entries?: unknown };

  // Refuse an unknown or future format version rather than guessing at its
  // shape.
  if (typeof m.formatVersion !== "number") {
    throw new ArchiveFormatError("manifest.json is missing a numeric formatVersion");
  }
  if (m.formatVersion !== FORMAT_VERSION) {
    throw new ArchiveFormatError(
      `unsupported archive format version ${m.formatVersion}; this build supports version ${FORMAT_VERSION}`,
    );
  }
  if (typeof m.entries !== "object" || m.entries === null) {
    throw new ArchiveFormatError("manifest.json is missing its entries table");
  }
  const manifestEntries = m.entries as Record<string, { sha256?: unknown } | undefined>;

  // Verify every OTHER entry's checksum BEFORE importing anything: a
  // partially-applied import of a corrupted archive is worse than a
  // refusal, so nothing below this point may run until every checksum in
  // the archive has been confirmed to match.
  //
  // This must check BOTH directions. Checking only "every manifest entry is
  // in the archive and matches" leaves a hole: an entry present in the ZIP
  // but absent from the manifest is then never checksummed and never
  // rejected by this loop. manifest.json itself is the one archive entry
  // deliberately excluded from both directions -- it cannot checksum
  // itself, and its own contents (formatVersion, entries table) are already
  // validated above by being parsed and required to have the right shape.
  for (const entry of entries) {
    if (entry.name === "manifest.json") continue;
    const expected = manifestEntries[entry.name];
    if (!expected || typeof expected.sha256 !== "string") {
      throw new ArchiveFormatError(`manifest.json has no checksum recorded for ${JSON.stringify(entry.name)}`);
    }
    if (sha256(entry.data) !== expected.sha256) {
      throw new ArchiveFormatError(
        `checksum mismatch for ${JSON.stringify(entry.name)}: the archive has been corrupted or tampered with`,
      );
    }
  }
  for (const name of Object.keys(manifestEntries)) {
    if (name === "manifest.json") continue;
    if (!findEntry(entries, name)) {
      throw new ArchiveFormatError(`manifest.json names ${JSON.stringify(name)} but the archive does not contain it`);
    }
  }

  const episodesEntry = findEntry(entries, "episodes.jsonl");
  if (!episodesEntry) {
    throw new ArchiveFormatError("archive is missing episodes.jsonl");
  }
  const episodeRecords = parseEpisodeLines(episodesEntry.data, "episodes.jsonl");

  const memoriesEntry = findEntry(entries, "memories.jsonl");
  if (!memoriesEntry) {
    throw new ArchiveFormatError("archive is missing memories.jsonl");
  }
  const records = parseMemoryLines(memoriesEntry.data, "memories.jsonl");

  // The whole import runs as one transaction (storage/store.ts's db.tx,
  // same idiom as deleteEverything/forget): the SHA256 gate above proves the
  // ARCHIVE BYTES match the manifest, but says nothing about whether every
  // row will insert -- a bad importance value, a text collision, or an
  // episodeId the archive omits can still throw partway through. Without
  // this, that throw would leave the destination store permanently
  // half-imported with no record of where it stopped. Everything or
  // nothing.
  return store.db.tx(() => {
    // Episodes import BEFORE memories: a memory carries an episodeId, and
    // memories.episode_id is a `REFERENCES episodes(id)` foreign key with
    // PRAGMA foreign_keys=ON (storage/db.ts) -- inserting a memory ahead of
    // the episode it references would fail that constraint. This also means
    // an imported memory's episodeId resolves to a real row in the
    // destination store, not just in the source it came from.
    let episodesImported = 0;
    let episodesSkipped = 0;
    for (const record of episodeRecords) {
      const result = store.importEpisode(
        {
          id: record.id,
          content: record.content,
          scope: record.scope,
          sourceClient: record.sourceClient,
          metadata: record.metadata,
        },
        CTX,
      );
      if (result.skipped) {
        episodesSkipped += 1;
      } else {
        episodesImported += 1;
      }
    }

    // Import preserves the original ids from the exporting store rather than
    // minting fresh ones -- see the doc comment on
    // storage/repositories/memories.ts's importMemory for why "just call
    // remember()" is wrong here: created_at is derived from the id, so a
    // fresh id would collapse every imported memory's creation time to this
    // moment and destroy the chronology this format exists to preserve.
    let imported = 0;
    let skipped = 0;
    for (const record of records) {
      const result = store.importMemory(
        {
          id: record.id,
          text: record.text,
          scope: record.scope,
          tags: record.tags,
          importance: record.importance,
          sourceClient: record.sourceClient,
          updatedAt: record.updatedAt,
          validFrom: record.validFrom,
          validUntil: record.validUntil,
          supersededBy: record.supersededBy,
          deletedAt: record.deletedAt,
          redacted: record.redacted,
          episodeId: record.episodeId,
        },
        CTX,
      );
      if (result.skipped) {
        skipped += 1;
      } else {
        imported += 1;
      }
    }

    return {
      imported,
      skipped,
      memories: records.length,
      episodesImported,
      episodesSkipped,
      episodes: episodeRecords.length,
    };
  });
}
