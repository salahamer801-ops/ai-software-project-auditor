import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ANALYSIS_LIMITS, type RepoSnapshot, type SandboxCase, type SandboxInfo } from "../types";
import { logger } from "../observability/log";
import { scrubSecrets } from "../engines/shared";
import { GUARD_FILENAME, GUARD_SOURCE } from "./guard";
import { selectRunnableTestFiles, type SkippedCandidate } from "./candidates";
import { parseTap } from "./tap";

/**
 * The execution sandbox: one restricted child process per runnable test file (§24, §42, §56).
 *
 * The shape of the guarantee, stated precisely because the report repeats it:
 *
 *  - the child runs with Node's permission model (`--permission`, only the workspace readable),
 *    so filesystem writes, `child_process`, workers and native addons are denied by the runtime;
 *  - it starts through `--import` of the guard, so outbound network entry points throw before
 *    project code is evaluated;
 *  - its environment is rebuilt from scratch — no `DATABASE_URL`, no tokens, no host paths;
 *  - it is killed with SIGKILL at the per-file deadline, and the whole phase has a wall budget;
 *  - the workspace is a temporary directory that is deleted in a `finally`.
 *
 * It is *not* a container and the result says so: this platform's published apps sleep between
 * requests and cannot start containers inside themselves, so isolation here is in-process and
 * enforced by the runtime's permission model rather than by the operating system.
 */

export type SandboxStatus = "executed" | "no-candidates" | "busy" | "disabled" | "error" | "timeout";

export interface SandboxResult {
  status: SandboxStatus;
  info: SandboxInfo;
  cases: SandboxCase[];
  passed: number;
  failed: number;
  skippedCount: number;
  /** Sum of the harness's own `# tests` counters. */
  total: number;
  durationMs: number;
  /** Per-file output, already masked and truncated. */
  output: string;
  /** The file that was killed at its deadline, when that happened. */
  timedOutFile: string | null;
  notes: string[];
}

/** Serialised inside one server process: two projects never execute at the same time. */
let active = false;

const MAX_BUFFER = 1_048_576;

function limits(): SandboxInfo["limits"] {
  const sandbox = ANALYSIS_LIMITS.sandbox;
  return {
    wallMs: sandbox.wallMs,
    perFileMs: sandbox.perFileMs,
    memoryMb: sandbox.memoryMb,
    maxFiles: sandbox.maxFiles,
    maxOutputBytes: sandbox.maxOutputBytes,
  };
}

function emptyInfo(files: string[], skipped: SkippedCandidate[]): SandboxInfo {
  return {
    mode: "restricted-process",
    limits: limits(),
    files,
    skipped: skipped.map((entry) => ({ path: entry.path, reason: entry.reason })),
    crashed: [],
    environment: { env: "scrubbed", network: "guarded", filesystem: "read-only", processes: "denied" },
    truncated: false,
  };
}

/** Resolves a repository-relative path inside the workspace, or null when it would escape. */
export function safeJoin(root: string, relative: string): string | null {
  if (!relative || relative.includes("\0")) return null;
  const normalised = path.posix.normalize(relative);
  if (normalised === "." || normalised.startsWith("..") || path.posix.isAbsolute(normalised)) return null;
  const absolute = path.resolve(root, normalised);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
  return absolute;
}

/** Copies the analysed text files into the workspace, bounded by the size limit. */
async function materialise(snapshot: RepoSnapshot, root: string): Promise<{ written: number; bytes: number; skipped: number }> {
  let written = 0;
  let bytes = 0;
  let skipped = 0;
  for (const file of snapshot.files) {
    if (!file.text || typeof file.content !== "string") continue;
    if (bytes + file.size > ANALYSIS_LIMITS.sandbox.maxWorkspaceBytes) {
      skipped += 1;
      continue;
    }
    const target = safeJoin(root, file.path);
    if (!target) {
      skipped += 1;
      continue;
    }
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
      written += 1;
      bytes += file.size;
    } catch {
      // A path that collides with a file already written (a/b and a) is skipped, not fatal.
      skipped += 1;
    }
  }
  return { written, bytes, skipped };
}

interface ChildOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
  durationMs: number;
}

async function runFile(cwd: string, guardUrl: string, file: string, timeoutMs: number): Promise<ChildOutcome> {
  const startedAt = Date.now();
  const args = [
    "--permission",
    `--allow-fs-read=${cwd}`,
    `--max-old-space-size=${ANALYSIS_LIMITS.sandbox.memoryMb}`,
    "--no-warnings",
    "--import",
    guardUrl,
    file,
  ];
  return new Promise<ChildOutcome>((resolve) => {
    execFile(
      process.execPath,
      args,
      {
        cwd,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: MAX_BUFFER,
        // Rebuilt, not inherited: the child must never see the platform's database URL or tokens.
        env: { NODE_ENV: "test", NO_COLOR: "1", LANG: "C.UTF-8", TZ: "UTC", HOME: cwd, TMPDIR: cwd },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        const err = error as (Error & { killed?: boolean; signal?: string; code?: string | number }) | null;
        const overflow = err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const timedOut = Boolean(err?.killed) && !overflow;
        resolve({
          exitCode: typeof err?.code === "number" ? err.code : err ? 1 : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut,
          overflow,
          durationMs,
        });
      },
    );
  });
}

export async function runSandbox(
  snapshot: RepoSnapshot,
  options: { enabled: boolean; budgetMs?: number },
): Promise<SandboxResult> {
  const sandboxLimits = limits();
  const emptyCases = { cases: [] as SandboxCase[], passed: 0, failed: 0, skippedCount: 0, total: 0, output: "" };

  if (!options.enabled) {
    return {
      status: "disabled",
      info: emptyInfo([], []),
      ...emptyCases,
      durationMs: 0,
      timedOutFile: null,
      notes: ["Execution was not requested for this audit."],
    };
  }

  const selection = selectRunnableTestFiles(snapshot, { maxFiles: sandboxLimits.maxFiles });
  if (selection.runnable.length === 0) {
    return {
      status: "no-candidates",
      info: emptyInfo([], selection.skipped),
      ...emptyCases,
      durationMs: 0,
      timedOutFile: null,
      notes: [
        selection.skipped.length > 0
          ? `No self-contained Node test file was found (${selection.skipped.length} test files were skipped).`
          : "No test file was found that this sandbox can run.",
      ],
    };
  }

  if (active) {
    return {
      status: "busy",
      info: emptyInfo([], selection.skipped),
      ...emptyCases,
      durationMs: 0,
      timedOutFile: null,
      notes: ["Another execution is already running on this host; this run was left to the static engines."],
    };
  }

  active = true;
  const startedAt = Date.now();
  const budget = Math.max(3_000, Math.min(options.budgetMs ?? sandboxLimits.wallMs, sandboxLimits.wallMs));
  const wallEnd = startedAt + budget;
  let directory = "";
  const outputChunks: string[] = [];
  const cases: SandboxCase[] = [];
  const crashed: { path: string; error: string }[] = [];
  const executed: string[] = [];
  const notes: string[] = [];
  let passed = 0;
  let failed = 0;
  let skippedCount = 0;
  let total = 0;
  let outputBytes = 0;
  let truncated = false;
  let timedOutFile: string | null = null;
  let status: SandboxStatus = "executed";

  try {
    directory = await mkdtemp(path.join(tmpdir(), "codeaudit-sandbox-"));
    const guardPath = path.join(directory, GUARD_FILENAME);
    await writeFile(guardPath, GUARD_SOURCE, "utf8");
    const guardUrl = pathToFileURL(guardPath).href;
    const materialised = await materialise(snapshot, directory);

    for (const candidate of selection.runnable) {
      const remaining = wallEnd - Date.now();
      if (remaining < 1_500) {
        status = "timeout";
        notes.push(`The wall-clock budget ended before every file ran (${executed.length}/${selection.runnable.length}).`);
        break;
      }
      const perFile = Math.min(sandboxLimits.perFileMs, Math.max(1_500, remaining));
      const outcome = await runFile(directory, guardUrl, candidate.path, perFile);
      const parsed = parseTap(outcome.stdout, directory);
      // Node only prints `location:` for results it considers interesting, so a passing case often
      // carries no path at all. Every case here came from the file we just ran: say so, rather than
      // handing the report an "unknown" that looks like missing evidence.
      const parsedCases = parsed.cases.map((item) =>
        !item.file || item.file === "unknown" ? { ...item, file: candidate.path } : item,
      );
      executed.push(candidate.path);

      if (!parsed.sawSummary && outcome.exitCode !== 0) {
        status = status === "executed" ? "error" : status;
        const lines = outcome.stderr.split("\n").filter((line) => line.trim());
        // The first line of a Node stack trace is the file location; the sentence that explains
        // the failure is the one carrying the error name, so that is the evidence worth keeping.
        const message =
          lines.find((line) => /error|exception|cannot find|unexpected/i.test(line) && !line.trim().startsWith("file:")) ??
          lines[0] ??
          "the suite could not be loaded";
        crashed.push({ path: candidate.path, error: scrubSecrets(message.trim()).slice(0, 400) });
      }

      if (outcome.timedOut) {
        status = "timeout";
        timedOutFile = timedOutFile ?? candidate.path;
        notes.push(`${candidate.path} did not finish within ${perFile} ms and was killed.`);
      }
      if (outcome.overflow) truncated = true;

      if (parsed.totals) {
        total += parsed.totals.tests;
        passed += parsed.totals.pass;
        failed += parsed.totals.fail;
        skippedCount += parsed.totals.skipped;
      }
      for (const entry of parsedCases) {
        if (cases.length < 60) cases.push(entry);
        else truncated = true;
      }

      const header = `# ${candidate.path} → exit ${outcome.exitCode ?? "signal"} in ${outcome.durationMs} ms${outcome.timedOut ? " (killed at the deadline)" : ""}`;
      const body = scrubSecrets(`${outcome.stdout}${outcome.stderr ? `\n${outcome.stderr}` : ""}`.trim());
      const chunk = `${header}\n${body}`;
      if (outputBytes + chunk.length <= sandboxLimits.maxOutputBytes) {
        outputChunks.push(chunk);
        outputBytes += chunk.length;
      } else {
        truncated = true;
      }
    }

    const info: SandboxInfo = {
      ...emptyInfo(executed, selection.skipped.slice(0, 40)),
      crashed,
      truncated,
    };
    const durationMs = Date.now() - startedAt;

    if (materialised.skipped > 0) {
      notes.push(`${materialised.skipped} file(s) were not copied into the workspace (size budget or path collision).`);
    }
    notes.push(
      `Executed ${executed.length} file(s) in ${durationMs} ms under a ${sandboxLimits.memoryMb} MB heap cap: ${passed} passed, ${failed} failed, ${skippedCount} skipped.`,
    );
    if (selection.skipped.length > 0) {
      notes.push(`${selection.skipped.length} test file(s) were not runnable here and are listed with their reason.`);
    }

    logger.info("sandbox.executed", {
      status,
      files: executed.length,
      passed,
      failed,
      skipped: skippedCount,
      crashed: crashed.length,
      durationMs,
      truncated,
    });

    return {
      status,
      info,
      cases,
      passed,
      failed,
      skippedCount,
      total,
      durationMs,
      output: outputChunks.join("\n\n").slice(0, sandboxLimits.maxOutputBytes),
      timedOutFile,
      notes,
    };
  } catch (error) {
    logger.error("sandbox.failed", { error });
    return {
      status: "error",
      info: { ...emptyInfo([], selection.skipped), crashed },
      cases,
      passed,
      failed,
      skippedCount,
      total,
      durationMs: Date.now() - startedAt,
      output: "",
      timedOutFile,
      notes: ["The execution sandbox could not complete on this host."],
    };
  } finally {
    active = false;
    if (directory) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
