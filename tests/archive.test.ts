/**
 * Archive intake (§24 / §56) — `lib/sources/extract.ts`.
 *
 * Everything here is untrusted input: the archives are built in memory (a hand-written
 * ustar writer plus `node:zlib`, and a stored zip with a real CRC32), and the tests assert
 * that a path designed to leave the extraction root never becomes an entry that is unsafe
 * to use, and that the size/entry budgets are enforced.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { gzipSync, deflateRawSync } from "node:zlib";
import { ArchiveError, detectArchive, extractArchive, isZip } from "../lib/sources/extract";

/* --------------------------- archive builders --------------------------- */

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

interface TarSpec {
  name: string;
  content?: string;
  /** "0" file, "2" symlink, "1" hard link, "5" directory. */
  typeFlag?: string;
  linkname?: string;
}

/** A minimal but real ustar header (checksum included, as any tar tool would write). */
function tarHeader(spec: TarSpec, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(spec.name.slice(0, 100), 0, "utf8");
  header.write(octal(0o644, 8), 100, "utf8");
  header.write(octal(0, 8), 108, "utf8");
  header.write(octal(0, 8), 116, "utf8");
  header.write(octal(size, 12), 124, "utf8");
  header.write(octal(0, 12), 136, "utf8");
  header.write("        ", 148, "utf8"); // checksum placeholder
  header.write((spec.typeFlag ?? "0").slice(0, 1), 156, "utf8");
  header.write((spec.linkname ?? "").slice(0, 100), 157, "utf8");
  header.write("ustar\0", 257, "utf8");
  header.write("00", 263, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
  return header;
}

function makeTar(specs: TarSpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const spec of specs) {
    const body = Buffer.from(spec.content ?? "", "utf8");
    const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    body.copy(padded);
    parts.push(tarHeader(spec, body.length), padded);
  }
  parts.push(Buffer.alloc(1024)); // end-of-archive marker
  return Buffer.concat(parts);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** A zip; entries are stored unless `deflate` is set, which uses the plain deflate method. */
function makeZip(entries: { name: string; content?: string; deflate?: boolean }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.content ?? "", "utf8");
    const payload = entry.deflate ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const method = entry.deflate ? 8 : 0;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, payload);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += header.length + name.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, eocd]);
}

/* -------------------------------- tests -------------------------------- */

const HOSTILE = [
  { name: "repo-abc123/../evil.ts", content: "bad" },
  { name: "repo-abc123/a/../../evil2.ts", content: "bad" },
  { name: "/etc/passwd", content: "root:x:0:0" },
  { name: "C:\\Windows\\evil.ts", content: "bad" },
  { name: "repo-abc123/symlink.ts", content: "", typeFlag: "2", linkname: "../../outside.ts" },
  { name: "repo-abc123/hardlink.ts", content: "", typeFlag: "1", linkname: "/etc/shadow" },
];

describe("detectArchive / isZip", () => {
  test("identifies tar, tar.gz and zip, by magic bytes and by name", () => {
    const tar = makeTar([{ name: "a.ts", content: "export const a = 1;\n" }]);
    const gz = gzipSync(tar);
    const zip = makeZip([{ name: "a.ts", content: "export const a = 1;\n" }]);

    assert.equal(detectArchive(tar, "repo.tar"), "tar", "ustar magic");
    assert.equal(detectArchive(gz, "repo.tar.gz"), "tar.gz", "gzip magic");
    assert.equal(detectArchive(gz, "upload.bin"), "tar.gz", "gzip magic without a helpful name");
    assert.equal(detectArchive(zip, "repo.zip"), "zip");
    assert.equal(detectArchive(zip, "download.bin"), "zip", "zip magic without a helpful name");
    assert.equal(isZip(zip), true);
    assert.equal(isZip(tar), false, "a tar is not a zip");
    assert.equal(isZip(Buffer.alloc(2)), false, "a 2-byte buffer is not a zip");

    // Name-only fallbacks: nothing in the bytes says anything, the extension decides.
    const emptyish = Buffer.from("PLAIN TEXT");
    assert.equal(detectArchive(emptyish, "notes.txt"), null, "an unknown format must not be guessed");
    assert.equal(detectArchive(emptyish, "archive.zip"), "zip");
    assert.equal(detectArchive(emptyish, "archive.tgz"), "tar.gz");
    assert.equal(detectArchive(emptyish, "archive.tar"), "tar");
  });

  test("rejects an unsupported archive instead of guessing", () => {
    assert.throws(
      () => extractArchive(Buffer.from("not an archive at all"), "notes.txt"),
      (error: unknown) => error instanceof ArchiveError && error.message === "unsupported_archive",
      "an unknown format must raise ArchiveError",
    );
  });
});

describe("extractArchive — path traversal", () => {
  test("no extracted path leaves the archive root", () => {
    const entries = extractArchive(makeTar([...HOSTILE, { name: "repo-abc123/src/index.ts", content: "export const x = 1;\n" }]), "repo.tar").entries;
    for (const entry of entries) {
      assert.ok(!entry.path.startsWith("/"), `${entry.path} is an absolute path`);
      assert.ok(!entry.path.includes(".."), `${entry.path} still contains a parent segment`);
      assert.ok(!/^[a-zA-Z]:/.test(entry.path), `${entry.path} is a Windows drive path`);
      assert.ok(!entry.path.includes("\\"), `${entry.path} kept a backslash`);
    }
  });

  test("an escaping entry is dropped, not rewritten into the root", () => {
    const result = extractArchive(
      makeTar([{ name: "repo/../evil.ts", content: "bad" }, { name: "repo/ok.ts", content: "fine" }]),
      "repo.tar",
    );
    assert.deepEqual(result.entries.map((entry) => entry.path), ["ok.ts"], "only the safe entry survives");
    assert.equal(result.skipped.ignoredPaths, 1, "the hostile path is counted as ignored");
  });

  test("an absolute path is stored relative to the root, never absolute", () => {
    const result = extractArchive(makeTar([{ name: "/etc/passwd", content: "root:x" }]), "x.tar");
    assert.deepEqual(result.entries.map((entry) => entry.path), ["etc/passwd"]);
    assert.ok(!result.entries[0].path.startsWith("/"), "the leading slash must be stripped");
  });

  test("symlinks and hard links never become file entries", () => {
    const result = extractArchive(
      makeTar([
        { name: "symlink.ts", content: "", typeFlag: "2", linkname: "../../outside.ts" },
        { name: "hardlink.ts", content: "", typeFlag: "1", linkname: "/etc/shadow" },
        { name: "keep.ts", content: "ok" },
      ]),
      "x.tar",
    );
    assert.deepEqual(result.entries.map((entry) => entry.path), ["keep.ts"], "link entries are skipped entirely");
  });

  test("an archive whose every entry is hostile is refused", () => {
    assert.throws(
      () => extractArchive(makeTar([{ name: "../../evil.ts", content: "bad" }]), "x.tar"),
      (error: unknown) => error instanceof ArchiveError && error.message === "no_readable_files",
      "nothing readable means no archive, not an empty one",
    );
  });

  test("an entry that starts with `../` is rejected, not rewritten", () => {
    // Regression: the GitHub wrapper heuristic used to nominate `..` as the archive prefix, so
    // `../evil.ts` was rewritten into `evil.ts` and accepted. An escaping entry is now dropped
    // before the prefix handling runs.
    assert.throws(
      () => extractArchive(makeTar([{ name: "../evil.ts", content: "bad" }]), "x.tar"),
      (error: unknown) => error instanceof ArchiveError && error.message === "no_readable_files",
      "a hostile entry must not become a readable file",
    );

    const mixed = extractArchive(
      makeTar([
        { name: "../evil.ts", content: "bad" },
        { name: "src/ok.ts", content: "ok" },
      ]),
      "x.tar",
    );
    assert.deepEqual(mixed.entries.map((entry) => entry.path), ["src/ok.ts"], "the hostile entry is dropped");
    assert.equal(mixed.skipped.ignoredPaths, 1, "and it is counted as ignored");
  });

  test("a directory entry is skipped without being counted as ignored", () => {
    const result = extractArchive(
      makeTar([{ name: "repo-abc123/", content: "", typeFlag: "5" }, { name: "repo-abc123/a.ts", content: "ok" }]),
      "x.tar",
    );
    assert.deepEqual(result.entries.map((entry) => entry.path), ["a.ts"]);
    assert.equal(result.skipped.ignoredPaths, 0, "a directory is not a rejected path");
  });

  test("vendored directories are ignored by path", () => {
    const result = extractArchive(
      makeTar([
        { name: "app/node_modules/pkg/index.js", content: "x" },
        { name: "app/vendor/lib.php", content: "x" },
        { name: "app/dist/bundle.js", content: "x" },
        { name: "app/src/main.ts", content: "ok" },
      ]),
      "x.tar",
    );
    assert.deepEqual(result.entries.map((entry) => entry.path), ["src/main.ts"]);
    assert.equal(result.skipped.ignoredPaths, 3);
  });

  test("the GitHub wrapper folder is stripped when every entry shares it", () => {
    const tar = makeTar([
      { name: "owner-repo-sha1/", content: "", typeFlag: "5" },
      { name: "owner-repo-sha1/src/index.ts", content: "ok" },
      { name: "owner-repo-sha1/README.md", content: "hi" },
    ]);
    assert.deepEqual(
      extractArchive(tar, "x.tar").entries.map((entry) => entry.path),
      ["src/index.ts", "README.md"],
      "the wrapper is detected and removed",
    );
    assert.deepEqual(
      extractArchive(tar, "x.tar", { stripPrefix: "owner-repo-sha1" }).entries.map((entry) => entry.path),
      ["src/index.ts", "README.md"],
      "an explicit prefix does the same thing",
    );
  });
});

describe("extractArchive — zip", () => {
  test("reads a stored zip and never emits an escaping name", () => {
    const zip = makeZip([
      { name: "repo/src/index.ts", content: "export const x = 1;\n" },
      { name: "../../evil.ts", content: "bad" },
      { name: "/absolute.ts", content: "bad" },
    ]);
    const result = extractArchive(zip, "repo.zip");
    assert.deepEqual(result.entries.map((entry) => entry.path), ["repo/src/index.ts", "absolute.ts"]);
    for (const entry of result.entries) {
      assert.ok(!entry.path.includes("..") && !entry.path.startsWith("/"), `${entry.path} is unsafe`);
    }
    assert.equal(result.skipped.ignoredPaths, 1, "the traversal entry is rejected");
  });

  test("classifies binary entries by extension and keeps them out of the text budget", () => {
    const zip = makeZip([
      { name: "logo.png", content: "\u0000\u0001binary" },
      { name: "index.ts", content: "export const x = 1;\n" },
    ]);
    const result = extractArchive(zip, "repo.zip");
    const png = result.entries.find((entry) => entry.path === "logo.png");
    assert.ok(png, "the binary file still appears in the manifest");
    assert.equal(png.binary, true, "a .png is binary even when short");
    assert.equal(png.text, undefined, "no text is decoded for a binary file");
    assert.equal(result.skipped.binarySkipped, 1);

    const source = result.entries.find((entry) => entry.path === "index.ts");
    assert.ok(source);
    assert.equal(source.binary, false);
    assert.equal(source.text, "export const x = 1;\n");
  });

  test("reads a deflated (compressed) zip entry", () => {
    const source = "export const x = 1;\n".repeat(50);
    const result = extractArchive(makeZip([{ name: "index.ts", content: source, deflate: true }]), "repo.zip");
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].path, "index.ts");
    assert.equal(result.entries[0].binary, false);
    assert.equal(result.entries[0].text, source, "the deflated entry must inflate back to the original bytes");
  });

  test("documented quirk: a single shared top-level folder is stripped from a zip too", () => {
    // The GitHub wrapper heuristic is not tar-specific: when every entry starts with the same
    // first segment, that segment is removed — so a zip that only contains `src/…` loses `src/`.
    const result = extractArchive(makeZip([{ name: "src/index.ts", content: "export const x = 1;\n" }]), "repo.zip");
    assert.deepEqual(result.entries.map((entry) => entry.path), ["index.ts"]);
  });

  test("a deflated traversal entry is still rejected", () => {
    const result = extractArchive(
      makeZip([
        { name: "../evil.ts", content: "bad", deflate: true },
        { name: "keep.ts", content: "ok", deflate: true },
      ]),
      "repo.zip",
    );
    assert.deepEqual(result.entries.map((entry) => entry.path), ["keep.ts"]);
    assert.equal(result.skipped.ignoredPaths, 1);
  });

  test("an unsupported compression method raises ArchiveError", () => {
    const zip = makeZip([{ name: "a.ts", content: "x" }]);
    // Rewrite both headers to method 12 (bzip2), which the extractor does not implement.
    zip.writeUInt16LE(12, 8);
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(12, eocd + 10);
    assert.throws(
      () => extractArchive(zip, "repo.zip"),
      (error: unknown) => error instanceof ArchiveError && /zip_method_unsupported/.test(error.message),
    );
  });

  test("a zip without a usable central directory raises ArchiveError", () => {
    const truncated = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(30)]);
    assert.throws(
      () => extractArchive(truncated, "broken.zip"),
      (error: unknown) => error instanceof ArchiveError && error.message === "zip_end_of_directory_missing",
    );
  });
});

describe("extractArchive — budgets", () => {
  test("the entry limit stops the walk and flags truncation", () => {
    const tar = makeTar(Array.from({ length: 5 }, (_, index) => ({ name: `file${index}.ts`, content: "x" })));
    const result = extractArchive(tar, "x.tar", { maxEntries: 2 });
    assert.equal(result.entries.length, 2, "only maxEntries entries are returned");
    assert.equal(result.skipped.truncated, true, "the caller must be told the archive was cut short");
  });

  test("the total-byte limit flags truncation and stops decoding text", () => {
    const tar = makeTar([
      { name: "a.ts", content: "a".repeat(40) },
      { name: "b.ts", content: "b".repeat(40) },
    ]);
    const result = extractArchive(tar, "x.tar", { maxTotalBytes: 50 });
    assert.equal(result.entries.length, 2, "the oversized entry still appears in the manifest");
    assert.equal(result.entries[0].text, "a".repeat(40), "the first file fits and is decoded");
    assert.equal(result.entries[1].binary, true, "the second file is marked binary instead of decoded");
    assert.equal(result.entries[1].text, undefined);
    assert.equal(result.skipped.truncated, true);
  });

  test("a gzipped tar takes the same path as an uncompressed one", () => {
    const tar = makeTar([
      { name: "src/index.ts", content: "export const x = 1;\n" },
      { name: "../evil.ts", content: "bad" },
    ]);
    const fromTar = extractArchive(tar, "x.tar");
    const fromGzip = extractArchive(gzipSync(tar), "x.tar.gz");
    assert.deepEqual(
      fromGzip.entries.map((entry) => entry.path),
      fromTar.entries.map((entry) => entry.path),
      "compression must not change which entries survive",
    );
    assert.equal(fromGzip.skipped.ignoredPaths, fromTar.skipped.ignoredPaths);
  });
});
