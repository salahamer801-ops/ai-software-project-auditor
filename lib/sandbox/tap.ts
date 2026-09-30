import { scrubSecrets } from "../engines/shared";
import type { SandboxCase } from "../types";

/**
 * Reading TAP, the reporter Node's own test runner writes when stdout is a pipe.
 *
 * Two things matter for evidence: the *summary* counts (the harness's own numbers, which we
 * never recompute by hand) and the *location* of each failing leaf — Node prints both the
 * declaration site (`location:`) and the assertion frame in `stack:`, and the frame inside the
 * workspace is what a finding should point at. Every path is mapped back from the temporary
 * workspace to the repository-relative path, because the temporary path is meaningless to the
 * person reading the report.
 */

export interface TapParse {
  cases: SandboxCase[];
  totals: { tests: number; pass: number; fail: number; skipped: number } | null;
  /** TAP was parseable enough to carry a summary line. */
  sawSummary: boolean;
}

interface RawResult {
  depth: number;
  ok: boolean;
  name: string;
  skipped: boolean;
  fields: Record<string, string>;
  hasChildren: boolean;
}

const RESULT_LINE = /^(\s*)(not ok|ok)\s+\d+\s+-\s+(.*)$/;
const SUMMARY_LINE = /^#\s+(tests|pass|fail|skipped|todo)\s+(\d+)$/;

export function toRepoPath(raw: string | undefined, workspace: string): { file: string | null; line: number | null } {
  if (!raw) return { file: null, line: null };
  // Frames arrive in several shapes: `(file:///w/a.js:1:2)`, `file:///w/a.js:1:2`, `at /w/a.js:1:2`.
  // Strip the wrappers first, then the scheme — the other order leaves `file://` in the path and
  // the workspace check below silently fails.
  const cleaned = raw
    .replace(/^\s+/, "")
    .replace(/^\(+/, "")
    .replace(/\)+$/, "")
    .replace(/^file:\/\//, "")
    .replace(/^at\s+/, "")
    .trim();
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(cleaned) ?? /^(.*?):(\d+)$/.exec(cleaned);
  const filePart = (match?.[1] ?? cleaned).trim();
  const line = match?.[2] ? Number(match[2]) : null;
  const prefix = workspace.endsWith("/") ? workspace : `${workspace}/`;
  if (!filePart.startsWith(prefix)) return { file: null, line };
  return { file: filePart.slice(prefix.length), line };
}

/** First frame in the stack that lives inside the workspace — where the assertion failed. */
function frameFromStack(stack: string | undefined, workspace: string): { file: string | null; line: number | null } {
  if (!stack) return { file: null, line: null };
  for (const line of stack.split("\n")) {
    for (const match of line.matchAll(/(?:\(|at\s+)([^()\s]+:\d+:\d+)\)?/g)) {
      const { file, line: number } = toRepoPath(match[1] ?? "", workspace);
      if (file) return { file, line: number };
    }
  }
  return { file: null, line: null };
}

/** Reads the indented YAML block that follows a result line, including `|-` block values. */
function readBlock(lines: string[], start: number): { fields: Record<string, string>; end: number } {
  const fields: Record<string, string> = {};
  let index = start;
  let key: string | null = null;
  // Indentation of the key currently being read. Block content is anything indented deeper than
  // its key — Node indents the whole YAML block by the result's own depth, so a fixed number of
  // spaces would silently drop the `error:` and `stack:` bodies of a top-level test.
  let keyIndent = 0;
  let buffer: string[] = [];
  const flush = () => {
    if (key) fields[key] = buffer.join("\n").trimEnd();
    key = null;
    buffer = [];
  };
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    // The block ends at its own terminator, and never runs into the next result. The pending
    // key is flushed first: the last key in the block (`stack`) is exactly the one findings need.
    if (trimmed === "..." || SUMMARY_LINE.test(line) || RESULT_LINE.test(line)) {
      flush();
      break;
    }
    const indent = line.length - line.trimStart().length;
    const entry = /^\s{2,}([A-Za-z_]+):\s?(.*)$/.exec(line);
    if (entry) {
      flush();
      key = entry[1] ?? null;
      keyIndent = indent;
      const value = (entry[2] ?? "").trim();
      if (value && value !== "|-" && value !== "|") buffer.push(value.replace(/^'(.*)'$/, "$1"));
    } else if (key && line.trim() && indent > keyIndent) {
      buffer.push(line.trim());
    }
    index += 1;
  }
  flush();
  return { fields, end: index };
}

export function parseTap(output: string, workspace: string): TapParse {
  const lines = output.split("\n");
  const results: RawResult[] = [];
  const pending: RawResult[] = [];
  const totals: { tests?: number; pass?: number; fail?: number; skipped?: number } = {};
  let sawSummary = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    const summary = SUMMARY_LINE.exec(line);
    if (summary) {
      const key = summary[1] as "tests" | "pass" | "fail" | "skipped" | "todo";
      if (key !== "todo") totals[key] = Number(summary[2]);
      sawSummary = true;
      continue;
    }

    const result = RESULT_LINE.exec(line);
    if (!result) continue;

    const depth = (result[1] ?? "").length;
    const ok = result[2] === "ok";
    let name = (result[3] ?? "").trim();
    let skipped = /#\s*(?:SKIP|skip)\b/.test(name);
    name = name.replace(/\s*#\s*(?:SKIP|skip|TODO|todo)\b.*$/, "").trim();

    const { fields, end } = readBlock(lines, index + 1);
    index = Math.max(index, end - 1);
    if ((fields.failureType ?? "") === "testTimeoutFailure") skipped = false;

    // TAP is post-order: a parent's line arrives after its children, so anything still pending
    // and deeper than this line is this line's child.
    let hasChildren = false;
    while (pending.length > 0 && (pending[pending.length - 1]?.depth ?? 0) > depth) {
      pending.pop();
      hasChildren = true;
    }
    const entry: RawResult = { depth, ok, name, skipped, fields, hasChildren };
    results.push(entry);
    pending.push(entry);
  }

  const cases: SandboxCase[] = [];
  for (const result of results) {
    if (result.hasChildren) continue;
    const fromStack = frameFromStack(result.fields.stack, workspace);
    const fromLocation = toRepoPath(result.fields.location, workspace);
    const file = fromStack.file ?? fromLocation.file;
    const line = fromStack.line ?? fromLocation.line;
    const message = scrubSecrets(
      [result.fields.error, result.fields.failureType ? `(${result.fields.failureType})` : ""]
        .filter(Boolean)
        .join(" ")
        .trim(),
    ).slice(0, 800);
    cases.push({
      name: scrubSecrets(result.name).slice(0, 300) || "unnamed test",
      file: file ?? result.fields.location ?? "unknown",
      line,
      ok: result.ok,
      skipped: result.skipped,
      durationMs: result.fields.duration_ms ? Number(result.fields.duration_ms) : null,
      message: result.ok || result.skipped ? null : message || "test failed",
    });
  }

  const hasTotals = totals.tests !== undefined || totals.pass !== undefined || totals.fail !== undefined;
  return {
    cases,
    totals: hasTotals
      ? {
          tests: totals.tests ?? 0,
          pass: totals.pass ?? 0,
          fail: totals.fail ?? 0,
          skipped: totals.skipped ?? 0,
        }
      : null,
    sawSummary,
  };
}
