import { gunzipSync, inflateRawSync } from "node:zlib";

export interface ExtractedEntry {
  path: string;
  size: number;
  /** Present when the entry was decoded as text within the budget. */
  text?: string;
  binary: boolean;
}

export class ArchiveError extends Error {}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "vendor",
  "bower_components",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".gradle",
  ".idea",
  ".vscode",
  ".vs",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".terraform",
  "target",
  ".dart_tool",
  "Pods",
  "DerivedData",
  "obj",
  ".venv-win",
  "site-packages",
  ".turbo",
  ".parcel-cache",
]);

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "ico", "icns", "pdf", "zip", "gz", "tgz", "bz2", "xz",
  "7z", "rar", "jar", "war", "class", "dll", "so", "dylib", "exe", "bin", "o", "a", "lib", "wasm", "woff",
  "woff2", "ttf", "otf", "eot", "mp3", "mp4", "mov", "avi", "mkv", "wav", "ogg", "psd", "ai", "sketch",
  "sqlite", "sqlite3", "db", "lockb", "pyc", "pyo", "pack", "idx", "dat", "log", "heic", "avif", "psb",
]);

/** Never read beyond this per file, even if the archive claims a bigger size. */
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

function normalisePath(raw: string): string | null {
  let path = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  path = path.replace(/\/{2,}/g, "/");
  if (!path) return null;
  const parts = path.split("/");
  if (parts.some((part) => part === ".." || part === "." || part === "")) return null;
  if (/^[a-zA-Z]:/.test(path)) return null;
  for (const part of parts.slice(0, -1)) {
    if (IGNORED_DIRS.has(part)) return null;
  }
  return path;
}

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx + 1).toLowerCase();
}

function looksBinary(ext: string, head: Buffer): boolean {
  if (BINARY_EXTENSIONS.has(ext)) return true;
  const sample = head.subarray(0, 8000);
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return true;
  }
  return false;
}

/* ------------------------------- ZIP ------------------------------- */

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

export function isZip(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 3 || buffer[2] === 5 || buffer[2] === 7);
}

function readZipEntries(buffer: Buffer): CentralEntry[] {
  const maxBack = Math.min(buffer.length, 66_000);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= buffer.length - maxBack && i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveError("zip_end_of_directory_missing");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || count === 0xffff) {
    // ZIP64 — look for the ZIP64 end of central directory locator.
    for (let i = eocd - 20; i >= 0 && i > eocd - 200; i -= 1) {
      if (buffer.readUInt32LE(i) === 0x07064b50) {
        const zip64Eocd = Number(buffer.readBigUInt64LE(i + 8));
        if (buffer.readUInt32LE(zip64Eocd) === 0x06064b50) {
          offset = Number(buffer.readBigUInt64LE(zip64Eocd + 48));
        }
        break;
      }
    }
  }

  const entries: CentralEntry[] = [];
  let cursor = offset;
  while (cursor + 46 <= buffer.length) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  if (entries.length === 0) throw new ArchiveError("zip_empty");
  return entries;
}

function readZipEntryData(buffer: Buffer, entry: CentralEntry): Buffer {
  const local = entry.localOffset;
  if (buffer.readUInt32LE(local) !== 0x04034b50) throw new ArchiveError("zip_local_header_invalid");
  const nameLen = buffer.readUInt16LE(local + 26);
  const extraLen = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLen + extraLen;
  // The central directory is authoritative for sizes; streams written with data
  // descriptors report 0 in the local header.
  let size = entry.compressedSize;
  if (!size) size = Math.min(buffer.length - start, MAX_ENTRY_BYTES + 1024);
  const data = buffer.subarray(start, Math.min(start + size, buffer.length));
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
  throw new ArchiveError(`zip_method_unsupported:${entry.method}`);
}

/* ------------------------------- TAR ------------------------------- */

interface TarEntry {
  name: string;
  size: number;
  body: Buffer;
}

function parseTar(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const nameField = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeField = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const typeFlag = String.fromCharCode(header[156] || 48);
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const size = sizeField ? parseInt(sizeField, 8) : 0;
    const bodyStart = offset + 512;
    const bodyEnd = Math.min(bodyStart + (Number.isFinite(size) ? size : 0), buffer.length);
    const body = buffer.subarray(bodyStart, bodyEnd);

    if (typeFlag === "L") {
      longName = body.toString("utf8").replace(/\0.*$/, "");
    } else if (typeFlag === "x" || typeFlag === "g") {
      // pax extended header — the path field inside it is optional for our purposes.
    } else if (typeFlag === "0" || typeFlag === "\0" || typeFlag === "48" || typeFlag === "") {
      const full = longName ?? (prefix ? `${prefix}/${nameField}` : nameField);
      longName = null;
      entries.push({ name: full, size, body });
    } else {
      longName = null;
    }
    offset = bodyStart + Math.ceil((Number.isFinite(size) ? size : 0) / 512) * 512;
  }
  if (entries.length === 0) throw new ArchiveError("tar_empty");
  return entries;
}

/* ----------------------------- public API -------------------------- */

export type ArchiveKind = "zip" | "tar" | "tar.gz";

export function detectArchive(buffer: Buffer, filename = ""): ArchiveKind | null {
  const lower = filename.toLowerCase();
  if (isZip(buffer)) return "zip";
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return "tar.gz";
  if (buffer.length > 262 && buffer.subarray(257, 262).toString("ascii") === "ustar") return "tar";
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".tar")) return "tar";
  return null;
}

export interface ExtractOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  /** Prefix stripped from every path (GitHub tarballs nest everything under one folder). */
  stripPrefix?: string | null;
}

export interface ExtractResult {
  entries: ExtractedEntry[];
  skipped: { binarySkipped: number; ignoredPaths: number; oversizedSkipped: number; truncated: boolean };
}

export function extractArchive(buffer: Buffer, filename: string, options: ExtractOptions = {}): ExtractResult {
  const kind = detectArchive(buffer, filename);
  if (!kind) throw new ArchiveError("unsupported_archive");
  const maxEntries = options.maxEntries ?? 6000;
  const maxTotalBytes = options.maxTotalBytes ?? 60 * 1024 * 1024;

  let raw: { path: string; data: Buffer }[] = [];
  if (kind === "zip") {
    raw = readZipEntries(buffer).map((entry) => ({
      path: entry.name,
      data: entry.uncompressedSize === 0 && entry.compressedSize === 0 ? Buffer.alloc(0) : readZipEntryData(buffer, entry),
    }));
  } else {
    const tarBuffer = kind === "tar.gz" ? gunzipSync(buffer, { maxOutputLength: 400 * 1024 * 1024 }) : buffer;
    if (tarBuffer.length > 400 * 1024 * 1024) throw new ArchiveError("archive_too_large");
    raw = parseTar(tarBuffer).map((entry) => ({ path: entry.name, data: entry.body }));
  }

  let declaredPrefix = options.stripPrefix ?? null;
  if (!declaredPrefix) {
    // GitHub tarballs wrap everything in "<owner>-<repo>-<sha>/".
    const first = raw.find((entry) => entry.path.includes("/"))?.path;
    if (first) {
      const candidate = first.split("/")[0]!;
      if (raw.slice(0, 40).every((entry) => entry.path.startsWith(`${candidate}/`))) declaredPrefix = candidate;
    }
  }

  const entries: ExtractedEntry[] = [];
  const skipped = { binarySkipped: 0, ignoredPaths: 0, oversizedSkipped: 0, truncated: false };
  let totalBytes = 0;

  for (const item of raw) {
    if (entries.length >= maxEntries) {
      skipped.truncated = true;
      break;
    }
    let path = item.path;
    if (path.endsWith("/")) continue;
    if (declaredPrefix && path.startsWith(`${declaredPrefix}/`)) path = path.slice(declaredPrefix.length + 1);
    const safe = normalisePath(path);
    if (!safe) {
      skipped.ignoredPaths += 1;
      continue;
    }
    const size = item.data.length;
    if (size > MAX_ENTRY_BYTES) {
      skipped.oversizedSkipped += 1;
      entries.push({ path: safe, size, binary: true });
      continue;
    }
    const ext = extensionOf(safe);
    if (looksBinary(ext, item.data)) {
      skipped.binarySkipped += 1;
      entries.push({ path: safe, size, binary: true });
      continue;
    }
    if (totalBytes + size > maxTotalBytes) {
      skipped.truncated = true;
      entries.push({ path: safe, size, binary: true });
      continue;
    }
    totalBytes += size;
    entries.push({
      path: safe,
      size,
      text: item.data.toString("utf8").replace(/^\uFEFF/, ""),
      binary: false,
    });
  }

  if (entries.length === 0) throw new ArchiveError("no_readable_files");
  return { entries, skipped };
}
