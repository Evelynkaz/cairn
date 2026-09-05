import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { withTempDir } from "../testing/tmp.js";
import { readZip, writeZip, ZipFormatError, type ZipEntry } from "./zip.js";

function which(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAVE_UNZIP = which("unzip");
const HAVE_ZIP = which("zip");
const HAVE_PYTHON3 = which("python3");

function sortByName(entries: ZipEntry[]): ZipEntry[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

// --- Round-trip through our own code ------------------------------------

test("round-trip: empty file, one-byte file, compressible file, random file, unicode name, many small entries", () => {
  const compressible = Buffer.from("a".repeat(10_000), "utf8");
  const random = randomBytes(10_000);

  const entries: ZipEntry[] = [
    { name: "empty.txt", data: Buffer.alloc(0) },
    { name: "one-byte.txt", data: Buffer.from([0x41]) },
    { name: "compressible.txt", data: compressible },
    { name: "random.bin", data: random },
    { name: "ünicode-日本語.txt", data: Buffer.from("hello") },
  ];
  for (let i = 0; i < 200; i++) {
    entries.push({ name: `many/small-${i}.txt`, data: Buffer.from(`entry ${i}`) });
  }

  const archive = writeZip(entries);
  const read = sortByName(readZip(archive));
  const expected = sortByName(entries);

  assert.equal(read.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(read[i]!.name, expected[i]!.name);
    assert.ok(read[i]!.data.equals(expected[i]!.data), `data mismatch for ${expected[i]!.name}`);
  }
});

test("stored is chosen for random bytes: archive is not larger than input plus a small header overhead", () => {
  const random = randomBytes(50_000);
  const archive = writeZip([{ name: "random.bin", data: random }]);
  // Local header (30) + name + central header (46) + name + eocd (22) is
  // the entire fixed overhead for a single entry; deflate must not have
  // been chosen (it would typically expand incompressible data slightly).
  const overhead = 30 + 46 + 22 + 2 * "random.bin".length;
  assert.ok(archive.length <= random.length + overhead, `archive ${archive.length} vs input ${random.length}`);
});

test("determinism: writing the same entries twice produces byte-identical buffers", () => {
  const entries: ZipEntry[] = [
    { name: "a.txt", data: Buffer.from("hello world".repeat(50)) },
    { name: "b.bin", data: randomBytes(1000) },
  ];
  const first = writeZip(entries);
  const second = writeZip(entries);
  assert.ok(first.equals(second));
});

// --- Rejections -----------------------------------------------------------

test("rejects a name with a .. segment", () => {
  assert.throws(() => writeZip([{ name: "../escape.txt", data: Buffer.alloc(0) }]), ZipFormatError);
});

test("rejects an absolute name", () => {
  assert.throws(() => writeZip([{ name: "/etc/passwd", data: Buffer.alloc(0) }]), ZipFormatError);
});

test("rejects a NUL byte in a name", () => {
  assert.throws(() => writeZip([{ name: "a\0b.txt", data: Buffer.alloc(0) }]), ZipFormatError);
});

test("rejects a truncated archive", () => {
  const archive = writeZip([{ name: "a.txt", data: Buffer.from("hello") }]);
  const truncated = archive.subarray(0, archive.length - 10);
  assert.throws(() => readZip(truncated), ZipFormatError);
});

test("rejects a corrupted CRC", () => {
  const archive = writeZip([{ name: "a.txt", data: Buffer.from("hello world, this needs to be long enough to survive a byte flip") }]);
  const corrupted = Buffer.from(archive);
  // Flip a byte inside the file data region (right after the local header + name).
  const dataOffset = 30 + "a.txt".length;
  corrupted[dataOffset] = corrupted[dataOffset]! ^ 0xff;
  assert.throws(() => readZip(corrupted), ZipFormatError);
});

test("rejects an archive declaring more entries than the cap", () => {
  const archive = writeZip([{ name: "a.txt", data: Buffer.from("x") }]);
  const tampered = Buffer.from(archive);
  const eocdOffset = tampered.length - 22;
  tampered.writeUInt16LE(0xffff, eocdOffset + 8);
  tampered.writeUInt16LE(0xffff, eocdOffset + 10);
  assert.throws(() => readZip(tampered), ZipFormatError);
});

test("rejects an archive declaring more uncompressed bytes than the cap (zip bomb shape)", () => {
  const archive = writeZip([{ name: "a.txt", data: Buffer.from("x") }]);
  const tampered = Buffer.from(archive);
  const eocdOffset = tampered.length - 22;
  const centralDirStart = tampered.readUInt32LE(eocdOffset + 16);
  // Central directory header uncompressed-size field is at offset +24.
  tampered.writeUInt32LE(0xffffffff, centralDirStart + 24);
  assert.throws(() => readZip(tampered), ZipFormatError);
});

// --- Verification against system tools ------------------------------------

test("writeZip output passes `unzip -t` and extracts byte-identical content", (t) => {
  if (!HAVE_UNZIP) {
    t.skip("unzip is not available on this machine");
    return;
  }
  withTempDir((dir) => {
    // ASCII names only: "-O" (charset override) is not supported by every
    // UnZip build (it fails on some CI images with usage output and a
    // non-zero exit), so it is not portable to pass here, and without it a
    // build can guess the wrong charset for a non-ASCII name. What this
    // test is really checking -- that a standard tool can read our archive
    // and the bytes survive -- doesn't need a non-ASCII name to prove;
    // UTF-8 filename coverage is verified separately below via python3's
    // zipfile, which honors the UTF-8 flag (bit 11) directly.
    const entries: ZipEntry[] = [
      { name: "hello.txt", data: Buffer.from("hello, world\n") },
      { name: "nested/dir/file.bin", data: randomBytes(2000) },
      { name: "cafe.txt", data: Buffer.from("cafe") },
    ];
    const archive = writeZip(entries);
    const archivePath = join(dir, "out.zip");
    writeFileSync(archivePath, archive);

    execFileSync("unzip", ["-t", archivePath], { stdio: "pipe" });

    const extractDir = join(dir, "extracted");
    execFileSync("unzip", ["-o", "-q", archivePath, "-d", extractDir]);
    for (const entry of entries) {
      const extractedPath = join(extractDir, entry.name);
      assert.ok(existsSync(extractedPath), `expected ${extractedPath} to exist`);
      const extracted = readFileSync(extractedPath);
      assert.ok(extracted.equals(entry.data), `content mismatch for ${entry.name}`);

      // Mode bits, not read success: root bypasses permission checks
      // entirely, so a plain read would pass either way and hide the bug
      // this guards against (external file attributes of 0 -> mode 000 on
      // extraction, see EXTERNAL_ATTRS_REGULAR_FILE in zip.ts). Inspecting
      // the mode itself is meaningful for every user, privileged or not.
      if (platform() === "win32") {
        t.skip("POSIX file mode bits are not meaningfully observable on Windows");
      } else {
        const mode = statSync(extractedPath).mode;
        assert.ok(mode & 0o400, `expected owner-read bit set, got mode ${(mode & 0o777).toString(8)}`);
      }
    }
  });
});

test("writeZip output is readable by python3's zipfile module with matching content", (t) => {
  if (!HAVE_PYTHON3) {
    t.skip("python3 is not available on this machine");
    return;
  }
  withTempDir((dir) => {
    const entries: ZipEntry[] = [
      { name: "a.txt", data: Buffer.from("alpha") },
      { name: "b/c.txt", data: Buffer.from("beta".repeat(500)) },
      { name: "ünicode-日本語.txt", data: Buffer.from("café") },
    ];
    const archive = writeZip(entries);
    const archivePath = join(dir, "out.zip");
    writeFileSync(archivePath, archive);

    const script = `
import zipfile, json, sys
with zipfile.ZipFile(${JSON.stringify(archivePath)}) as zf:
    bad = zf.testzip()
    if bad is not None:
        print("BAD:" + bad)
        sys.exit(1)
    out = {name: zf.read(name).decode("utf-8", "surrogateescape") for name in zf.namelist()}
    print(json.dumps(out))
`;
    const output = execFileSync("python3", ["-c", script], { encoding: "utf8" });
    const result = JSON.parse(output) as Record<string, string>;
    for (const entry of entries) {
      assert.equal(result[entry.name], entry.data.toString("utf8"));
    }
  });
});

// --- Reading an archive we did not write -----------------------------------

test("readZip reads an archive produced by the system `zip` command", (t) => {
  if (!HAVE_ZIP) {
    t.skip("zip is not available on this machine");
    return;
  }
  withTempDir((dir) => {
    const files: Record<string, Buffer> = {
      "readme.txt": Buffer.from("this file was zipped by the system zip command\n".repeat(20)),
      "data.bin": randomBytes(500),
    };
    for (const [name, data] of Object.entries(files)) {
      writeFileSync(join(dir, name), data);
    }

    const archivePath = join(dir, "system.zip");
    execFileSync("zip", ["-q", archivePath, ...Object.keys(files)], { cwd: dir });

    const archive = readFileSync(archivePath);
    const read = readZip(archive);
    assert.equal(read.length, Object.keys(files).length);
    for (const entry of read) {
      const expected = files[entry.name];
      assert.ok(expected, `unexpected entry ${entry.name}`);
      assert.ok(entry.data.equals(expected!), `content mismatch for ${entry.name}`);
    }
  });
});
