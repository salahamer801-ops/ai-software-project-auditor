import { ANALYSIS_LIMITS, type RepoFile, type RepoSnapshot } from "../types";
import { detectStack, languageOf } from "../engines/stack";
import type { ExtractedEntry } from "./extract";

export interface SnapshotSource {
  type: "github" | "upload" | "demo";
  label: string;
  repositoryUrl?: string;
  owner?: string;
  repo?: string;
  ref?: string;
  commitSha?: string;
  bytes?: number;
}

export function countLoc(content: string, language: string): { lines: number; loc: number } {
  const rows = content.split("\n");
  const blockComment = ["javascript", "typescript", "css", "scss", "java", "php", "go", "csharp", "dart", "kotlin", "c", "cpp"].includes(
    language,
  );
  let inBlock = false;
  let loc = 0;
  for (const row of rows) {
    const trimmed = row.trim();
    if (!trimmed) continue;
    if (blockComment) {
      if (inBlock) {
        if (trimmed.includes("*/")) inBlock = false;
        continue;
      }
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlock = true;
        continue;
      }
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;
    loc += 1;
  }
  return { lines: rows.length, loc };
}

export function buildSnapshot(
  entries: ExtractedEntry[],
  source: SnapshotSource,
  skipped: { binarySkipped: number; ignoredPaths: number; oversizedSkipped: number; truncated: boolean },
  limits = ANALYSIS_LIMITS,
): RepoSnapshot {
  const files: RepoFile[] = [];
  let bytes = 0;

  for (const entry of entries) {
    const language = languageOf(entry.path);
    const content = entry.text;
    const stats = content
      ? countLoc(content, language)
      : { lines: 0, loc: 0 };
    files.push({
      path: entry.path,
      size: entry.size,
      text: !entry.binary,
      language,
      lines: stats.lines,
      loc: stats.loc,
      content,
    });
    bytes += entry.size;
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  const textFiles = files.filter((file) => file.text);
  const stack = detectStack(files);

  return {
    files,
    stack,
    totals: {
      fileCount: files.length,
      textFileCount: textFiles.length,
      bytes,
      loc: stack.totalLoc,
      binarySkipped: skipped.binarySkipped,
      oversizedSkipped: skipped.oversizedSkipped,
      ignoredPaths: skipped.ignoredPaths,
      truncated: skipped.truncated,
    },
    source,
    limits,
  };
}

export function snapshotFromRawFiles(
  raw: { path: string; content: string }[],
  source: SnapshotSource,
  limits = ANALYSIS_LIMITS,
): RepoSnapshot {
  const entries: ExtractedEntry[] = raw.map((file) => ({
    path: file.path,
    size: Buffer.byteLength(file.content, "utf8"),
    text: file.content,
    binary: false,
  }));
  return buildSnapshot(entries, source, {
    binarySkipped: 0,
    ignoredPaths: 0,
    oversizedSkipped: 0,
    truncated: false,
  }, limits);
}

export function truncateSnippet(content: string, targetLine: number, radius = 4): { snippet: string; startLine: number } {
  const lines = content.split("\n");
  const start = Math.max(0, targetLine - 1 - radius);
  const end = Math.min(lines.length, targetLine + radius);
  return { snippet: lines.slice(start, end).join("\n"), startLine: start + 1 };
}
