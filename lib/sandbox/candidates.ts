import { isTestFile } from "../engines/stack";
import type { RepoFile, RepoSnapshot } from "../types";

/**
 * Deciding what may run (§24, §56).
 *
 * The sandbox can execute a test file only when the file is self-contained: it uses Node's own
 * test runner and imports nothing that would have to be installed. That is a deliberate choice
 * of precision over coverage — running a Jest suite without its dependencies would produce
 * failures that belong to the *harness*, not to the project, and a finding must never blame
 * code for something the tool could not provide.
 *
 * Everything rejected here is reported with a reason code, so the report can say exactly which
 * tests did not run and why, instead of implying the suite passed.
 */

export type SkipReason =
  | "needs-runner"
  | "needs-dependencies"
  | "too-large"
  | "unsupported-language"
  | "over-limit";

export interface SkippedCandidate {
  path: string;
  reason: SkipReason;
  detail?: string;
}

export interface CandidateSelection {
  runnable: RepoFile[];
  skipped: SkippedCandidate[];
}

const RUNNABLE_EXTENSION = /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/i;
const NODE_TEST_IMPORT = /(?:\bfrom\s*|\brequire\s*\(|\bimport\s*\()\s*['"]node:test['"]/;
const SPECIFIER = /(?:\bfrom\s*|\brequire\s*\(|\bimport\s*\()\s*['"]([^'"\n]+)['"]/g;
const MAX_FILE_BYTES = 150_000;
const MAX_IMPORT_DEPTH = 3;

/** Bare specifier = anything that is not a relative path and not a Node builtin. */
function bareSpecifier(specifier: string): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  if (specifier.startsWith("node:")) return false;
  return true;
}

export function specifiersOf(content: string): string[] {
  const found: string[] = [];
  for (const match of content.matchAll(SPECIFIER)) {
    const specifier = match[1];
    if (specifier && !found.includes(specifier)) found.push(specifier);
  }
  return found;
}

function normalisePosix(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return "..";
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

/** Resolve a relative specifier against the snapshot; null when it leaves the project. */
export function resolveRelative(from: string, specifier: string, files: Map<string, RepoFile>): string | null {
  if (!specifier.startsWith(".")) return null;
  const baseDir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const raw = normalisePosix(`${baseDir}/${specifier}`);
  if (!raw || raw.startsWith("..")) return null;
  const candidates = [
    raw,
    `${raw}.ts`,
    `${raw}.tsx`,
    `${raw}.js`,
    `${raw}.jsx`,
    `${raw}.mjs`,
    `${raw}.cjs`,
    `${raw}/index.ts`,
    `${raw}/index.tsx`,
    `${raw}/index.js`,
    `${raw}/index.mjs`,
  ];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

/**
 * Walks the file's own relative imports (bounded) looking for anything that must be installed.
 * Returns the offending specifier, or null when the whole reachable sub-graph is self-contained.
 */
function externalDependency(from: string, files: Map<string, RepoFile>, depth = 0): string | null {
  const file = files.get(from);
  if (!file || typeof file.content !== "string") return null;
  for (const specifier of specifiersOf(file.content)) {
    if (bareSpecifier(specifier)) return specifier;
    if (depth >= MAX_IMPORT_DEPTH) continue;
    const target = resolveRelative(from, specifier, files);
    if (!target) continue;
    const nested = externalDependency(target, files, depth + 1);
    if (nested) return nested;
  }
  return null;
}

export function selectRunnableTestFiles(
  snapshot: RepoSnapshot,
  options: { maxFiles: number } = { maxFiles: 8 },
): CandidateSelection {
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  const runnable: RepoFile[] = [];
  const skipped: SkippedCandidate[] = [];

  for (const file of snapshot.files) {
    if (!file.text || typeof file.content !== "string") continue;
    if (!isTestFile(file.path) || !RUNNABLE_EXTENSION.test(file.path)) continue;

    if (file.size > MAX_FILE_BYTES) {
      skipped.push({ path: file.path, reason: "too-large", detail: `${Math.round(file.size / 1024)} KB` });
      continue;
    }
    if (!["javascript", "typescript"].includes(file.language)) {
      skipped.push({ path: file.path, reason: "unsupported-language", detail: file.language });
      continue;
    }
    // Only files that name Node's own runner are executed. A suite written for Jest/Vitest
    // imports its runner (or relies on its globals), and running it here would report the
    // missing runner as a project failure.
    if (!NODE_TEST_IMPORT.test(file.content)) {
      skipped.push({ path: file.path, reason: "needs-runner" });
      continue;
    }
    const external = externalDependency(file.path, files);
    if (external) {
      skipped.push({ path: file.path, reason: "needs-dependencies", detail: external });
      continue;
    }
    runnable.push(file);
  }

  runnable.sort((a, b) => a.path.localeCompare(b.path));
  if (runnable.length > options.maxFiles) {
    for (const file of runnable.slice(options.maxFiles)) {
      skipped.push({ path: file.path, reason: "over-limit", detail: String(options.maxFiles) });
    }
    runnable.length = options.maxFiles;
  }
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return { runnable, skipped };
}
