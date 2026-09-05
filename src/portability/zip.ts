// Minimal, dependency-free ZIP reader/writer for Cairn's export/import
// feature (BUILD_BRIEF §10). This is deliberately not a general-purpose ZIP
// library: it implements exactly the subset an export archive needs (stored
// + deflate entries, UTF-8 names, a central directory) so that a user can
// open an exported archive with their OS's own tools, and so we can read
// back anything a normal ZIP tool produces within that same subset.
//
// No dependencies beyond node:zlib/node:crypto/node:buffer -- per the ZIP
// format spec (APPNOTE.TXT), all multi-byte fields are little-endian.

import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Forward-slash relative path inside the archive. */
  name: string;
  data: Buffer;
}

/** Thrown for anything wrong with archive *bytes*, as opposed to a bug in
 * this module -- callers use this to say "that's not a valid Cairn
 * archive" instead of surfacing an internal fault. */
export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

// --- CRC-32 (table-driven, per the standard ZIP/PNG polynomial 0xEDB88320) ---
// Zip integrity depends on this being exactly right, so it is the textbook
// table-driven implementation rather than a hand-rolled approximation.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i]!;
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Compression method codes used in the local/central headers.
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

// Signatures, per APPNOTE.TXT.
const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

// Fixed DOS date/time (1980-01-01 00:00:00, the DOS epoch) instead of the
// current clock: writeZip must be deterministic so that exporting the same
// store twice produces byte-identical output, which is what makes the
// export's SHA256 manifest meaningful (BUILD_BRIEF §10). "No time" (0x21)
// is the ZIP convention for a fixed, meaningless timestamp.
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x0021;

// Language-encoding flag (bit 11 of the general-purpose bit flag): marks
// the name/comment fields as UTF-8 so non-ASCII names survive round-trips
// through other tools instead of being reinterpreted as CP437/local codepage.
const FLAG_UTF8 = 0x0800;

// "Version made by" high byte identifies the host filesystem/OS the archive
// was written on (3 = Unix). Info-Zip's `unzip` only trusts the UTF-8 flag
// above for entries from a Unix-flavored writer -- an MS-DOS/FAT host byte
// (0) makes it fall back to decoding names as CP437, garbling non-ASCII
// names even though the flag bit is set correctly. Every real-world zip
// tool we compared against (system `zip`, Python's zipfile) sets this to
// Unix, so we match that instead of the technically-also-valid FAT value.
const HOST_UNIX = 3;
const VERSION_MADE_BY = (HOST_UNIX << 8) | 20;

// External file attributes, high 16 bits: once VERSION_MADE_BY claims a Unix
// host, `unzip` (and other Unix-aware tools) interpret these bits as the
// Unix mode to apply to the extracted file -- it does NOT fall back to a
// sane default when they're zero, it applies literal mode 000, making every
// extracted file unreadable until the user chmods it. The two fields are
// coupled: if VERSION_MADE_BY is ever changed back to a DOS/FAT host byte,
// this field becomes meaningless to Unix tools and can be dropped, but as
// long as it says Unix this must carry a real mode. 0o644 (rw-r--r--) is
// the sane default for a regular file written by an export.
const UNIX_FILE_MODE = 0o644;
const EXTERNAL_ATTRS_REGULAR_FILE = UNIX_FILE_MODE << 16;

// --- Safety caps for reading untrusted archives -----------------------

// A user can hand us an arbitrary file claiming to be a Cairn export.
// These caps bound the work readZip will do before it has verified
// anything, so a small malicious/corrupt archive (a "zip bomb" declaring a
// huge uncompressed size, or an absurd entry count) is refused up front
// rather than causing an unbounded allocation or loop.
const MAX_ENTRIES = 100_000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

function validateEntryName(name: string): void {
  if (name.length === 0) {
    throw new ZipFormatError("zip entry has an empty name");
  }
  if (name.includes("\0")) {
    throw new ZipFormatError(`zip entry name contains a NUL byte: ${JSON.stringify(name)}`);
  }
  if (name.includes("\\")) {
    throw new ZipFormatError(`zip entry name contains a backslash: ${JSON.stringify(name)}`);
  }
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
    throw new ZipFormatError(`zip entry name is absolute: ${JSON.stringify(name)}`);
  }
  const segments = name.split("/");
  if (segments.includes("..")) {
    throw new ZipFormatError(`zip entry name escapes the archive root: ${JSON.stringify(name)}`);
  }
}

function dosDateTime(): { time: number; date: number } {
  return { time: FIXED_DOS_TIME, date: FIXED_DOS_DATE };
}

interface PreparedEntry {
  nameBytes: Buffer;
  data: Buffer;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
}

function prepareEntry(entry: ZipEntry): PreparedEntry {
  validateEntryName(entry.name);
  const nameBytes = Buffer.from(entry.name, "utf8");
  const crc = crc32(entry.data);
  const uncompressedSize = entry.data.length;

  // Try deflate, but only use it when it actually helps: never emit a
  // "compressed" entry larger than the stored form (e.g. random or
  // already-compressed input often expands slightly under deflate).
  const deflated = deflateRawSync(entry.data);
  const useDeflate = deflated.length < entry.data.length;

  return {
    nameBytes,
    data: useDeflate ? deflated : entry.data,
    method: useDeflate ? METHOD_DEFLATE : METHOD_STORED,
    crc,
    compressedSize: useDeflate ? deflated.length : entry.data.length,
    uncompressedSize,
  };
}

/** Builds a complete ZIP archive in memory. */
export function writeZip(entries: readonly ZipEntry[]): Buffer {
  const prepared = entries.map(prepareEntry);
  const { time, date } = dosDateTime();

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const localOffsets: number[] = [];

  for (const e of prepared) {
    localOffsets.push(offset);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(FLAG_UTF8, 6);
    localHeader.writeUInt16LE(e.method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(e.crc, 14);
    localHeader.writeUInt32LE(e.compressedSize, 18);
    localHeader.writeUInt32LE(e.uncompressedSize, 22);
    localHeader.writeUInt16LE(e.nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, e.nameBytes, e.data);
    offset += localHeader.length + e.nameBytes.length + e.data.length;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIR_HEADER_SIG, 0);
    centralHeader.writeUInt16LE(VERSION_MADE_BY, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(FLAG_UTF8, 8);
    centralHeader.writeUInt16LE(e.method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(e.crc, 16);
    centralHeader.writeUInt32LE(e.compressedSize, 20);
    centralHeader.writeUInt32LE(e.uncompressedSize, 24);
    centralHeader.writeUInt16LE(e.nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(EXTERNAL_ATTRS_REGULAR_FILE, 38); // external file attributes
    centralHeader.writeUInt32LE(localOffsets[localOffsets.length - 1]!, 42);

    centralParts.push(centralHeader, e.nameBytes);
  }

  const centralDirStart = offset;
  const centralDirBuffer = Buffer.concat(centralParts);
  const centralDirSize = centralDirBuffer.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIR_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(prepared.length, 8); // entries on this disk
  eocd.writeUInt16LE(prepared.length, 10); // total entries
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirBuffer, eocd]);
}

// Reads a fixed-width little-endian field, throwing our typed error instead
// of letting node:buffer's RangeError leak out when the archive is
// truncated. `readerName` names the field for a useful message.
function readUInt16(buf: Buffer, offset: number, fieldName: string): number {
  if (offset < 0 || offset + 2 > buf.length) {
    throw new ZipFormatError(`truncated zip archive: cannot read ${fieldName} at offset ${offset}`);
  }
  return buf.readUInt16LE(offset);
}

function readUInt32(buf: Buffer, offset: number, fieldName: string): number {
  if (offset < 0 || offset + 4 > buf.length) {
    throw new ZipFormatError(`truncated zip archive: cannot read ${fieldName} at offset ${offset}`);
  }
  return buf.readUInt32LE(offset);
}

function readSlice(buf: Buffer, offset: number, length: number, fieldName: string): Buffer {
  if (offset < 0 || offset + length > buf.length) {
    throw new ZipFormatError(`truncated zip archive: cannot read ${fieldName} at offset ${offset}`);
  }
  return buf.subarray(offset, offset + length);
}

// Locates the end-of-central-directory record by scanning backward from the
// end of the file for its signature. The EOCD has a variable-length comment
// (0-65535 bytes) after it, so it is not at a fixed offset; scanning from
// the tail is the standard approach every ZIP reader uses.
const EOCD_FIXED_SIZE = 22;
const MAX_COMMENT_LENGTH = 0xffff;

function findEndOfCentralDirectory(buf: Buffer): number {
  if (buf.length < EOCD_FIXED_SIZE) {
    throw new ZipFormatError("truncated zip archive: shorter than a minimal end-of-central-directory record");
  }
  const searchStart = Math.max(0, buf.length - EOCD_FIXED_SIZE - MAX_COMMENT_LENGTH);
  for (let i = buf.length - EOCD_FIXED_SIZE; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === END_OF_CENTRAL_DIR_SIG) {
      return i;
    }
  }
  throw new ZipFormatError("not a valid zip archive: end-of-central-directory record not found");
}

// Note: readZip deliberately does not read external file attributes (the
// Unix mode set by writeZip, see EXTERNAL_ATTRS_REGULAR_FILE above). We
// always write buffers straight back to the caller in memory -- we never
// extract to disk ourselves -- so there is nothing here for a mode to
// apply to. Don't add speculative handling for it.

/** Reads an archive written by writeZip, or by any ordinary ZIP tool within the subset below. */
export function readZip(archive: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(archive);

  const totalEntries = readUInt16(archive, eocdOffset + 10, "total central directory entries");
  const centralDirSize = readUInt32(archive, eocdOffset + 12, "central directory size");
  const centralDirStart = readUInt32(archive, eocdOffset + 16, "central directory start offset");

  // A ZIP64 EOCD locator sits immediately before a plain EOCD when present.
  // We don't support ZIP64 (no export needs more than 4 GiB or 65535
  // entries), but a locator alone doesn't mean the archive actually needs
  // ZIP64 sizing -- only refuse if the plain-EOCD fields we just read are
  // the ZIP64 sentinel values (0xffff/0xffffffff), meaning the real sizes
  // live in the ZIP64 record we don't parse.
  const locatorOffset = eocdOffset - 20;
  if (
    locatorOffset >= 0 &&
    locatorOffset + 4 <= archive.length &&
    archive.readUInt32LE(locatorOffset) === ZIP64_EOCD_LOCATOR_SIG
  ) {
    if (totalEntries === 0xffff || centralDirSize === 0xffffffff || centralDirStart === 0xffffffff) {
      throw new ZipFormatError("zip64 archives are not supported");
    }
    // Otherwise: locator present but the plain EOCD fields are real values
    // (e.g. a tool wrote a defensive locator anyway) -- proceed normally.
  }

  if (totalEntries > MAX_ENTRIES) {
    throw new ZipFormatError(`zip archive declares ${totalEntries} entries, exceeding the cap of ${MAX_ENTRIES}`);
  }

  if (centralDirStart + centralDirSize > eocdOffset) {
    throw new ZipFormatError("malformed zip archive: central directory overruns end-of-central-directory record");
  }

  const entries: ZipEntry[] = [];
  let pos = centralDirStart;
  let totalUncompressed = 0;

  for (let i = 0; i < totalEntries; i++) {
    const sig = readUInt32(archive, pos, "central directory header signature");
    if (sig !== CENTRAL_DIR_HEADER_SIG) {
      throw new ZipFormatError(`malformed zip archive: bad central directory signature at entry ${i}`);
    }
    const method = readUInt16(archive, pos + 10, "compression method");
    const crc = readUInt32(archive, pos + 16, "crc-32");
    const compressedSize = readUInt32(archive, pos + 20, "compressed size");
    const uncompressedSize = readUInt32(archive, pos + 24, "uncompressed size");
    const nameLength = readUInt16(archive, pos + 28, "file name length");
    const extraLength = readUInt16(archive, pos + 30, "extra field length");
    const commentLength = readUInt16(archive, pos + 32, "file comment length");
    const localHeaderOffset = readUInt32(archive, pos + 42, "relative offset of local header");
    const nameBytes = readSlice(archive, pos + 46, nameLength, "file name");
    const name = nameBytes.toString("utf8");

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new ZipFormatError(
        `zip archive declares more than ${MAX_TOTAL_UNCOMPRESSED_BYTES} total uncompressed bytes`,
      );
    }

    validateEntryName(name);

    // Read the local header to find where the actual data starts: its name
    // and extra-field lengths can differ in length (though not content)
    // from the central directory's copy, so we must read them rather than
    // assume they match.
    const localSig = readUInt32(archive, localHeaderOffset, "local file header signature");
    if (localSig !== LOCAL_FILE_HEADER_SIG) {
      throw new ZipFormatError(`malformed zip archive: bad local file header signature for ${JSON.stringify(name)}`);
    }
    const localNameLength = readUInt16(archive, localHeaderOffset + 26, "local file name length");
    const localExtraLength = readUInt16(archive, localHeaderOffset + 28, "local extra field length");
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressedData = readSlice(archive, dataStart, compressedSize, `entry data for ${JSON.stringify(name)}`);

    let data: Buffer;
    if (method === METHOD_STORED) {
      data = Buffer.from(compressedData);
    } else if (method === METHOD_DEFLATE) {
      try {
        // maxOutputLength caps inflation at the entry's OWN declared
        // uncompressed size, not just the archive-wide total checked above:
        // that total is summed from declared sizes before any inflating
        // happens, so a single entry lying about its size (declaring 100
        // bytes for a stream that actually expands to 200MB) would pass
        // that check and only get caught by the length comparison below --
        // after the real 200MB had already been allocated, which is the
        // allocation this cap exists to prevent. Failing during inflation
        // instead means the lying stream never gets fully materialized.
        data = inflateRawSync(compressedData, { maxOutputLength: uncompressedSize });
      } catch (err) {
        throw new ZipFormatError(
          `failed to inflate entry ${JSON.stringify(name)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      throw new ZipFormatError(`unsupported compression method ${method} for entry ${JSON.stringify(name)}`);
    }

    if (data.length !== uncompressedSize) {
      throw new ZipFormatError(
        `entry ${JSON.stringify(name)} declared uncompressed size ${uncompressedSize} but produced ${data.length}`,
      );
    }

    const actualCrc = crc32(data);
    if (actualCrc !== crc) {
      throw new ZipFormatError(
        `crc-32 mismatch for entry ${JSON.stringify(name)}: expected ${crc.toString(16)}, got ${actualCrc.toString(16)}`,
      );
    }

    entries.push({ name, data });
    pos += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
