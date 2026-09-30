import type { RawFinding, TestRunRecord } from "../types";
import { runSandbox, type SandboxResult } from "../sandbox/run";
import { makeFinding } from "./shared";

/**
 * The execution engine (§23, §24).
 *
 * It is the only engine that runs code from the audited project, and everything it produces is
 * deterministic: a failing case becomes a finding with the *line the assertion failed on*, taken
 * from the runner's own stack frame, at the highest confidence the system uses (0.99) because
 * nothing was inferred. When the run cannot happen, no finding is invented for it — the reason
 * travels in the audit notes and the report's limitations section instead.
 *
 * Findings are capped: the report shows the first cases and the run record carries the totals, so
 * a project with two hundred failures gets ten findings and an honest count rather than a wall of
 * duplicates.
 */

const MAX_FAILURE_FINDINGS = 10;

export interface ExecutionEngineResult {
  findings: RawFinding[];
  testRun: TestRunRecord | null;
  notes: string[];
  /** True only when at least one file really ran. */
  executed: boolean;
  result: SandboxResult;
}

export async function runExecutionEngine(
  snapshot: Parameters<typeof runSandbox>[0],
  options: { enabled: boolean; budgetMs?: number },
): Promise<ExecutionEngineResult> {
  const result = await runSandbox(snapshot, options);
  const findings: RawFinding[] = [];

  if (result.status === "disabled" || result.status === "no-candidates" || result.status === "busy") {
    return { findings, testRun: null, notes: result.notes, executed: false, result };
  }

  const failing = result.cases.filter((item) => !item.ok && !item.skipped);
  for (const item of failing.slice(0, MAX_FAILURE_FINDINGS)) {
    const file = item.file && item.file !== "unknown" ? item.file : (result.info.files[0] ?? "unknown");
    findings.push(
      makeFinding({
        ruleId: "TST-006",
        path: file,
        line: item.line ?? 1,
        snippet: `${item.name}\n${item.message ?? "the assertion failed"}`,
        confidence: 0.99,
        severityReason: `Executed in the sandbox: the case "${item.name}" failed.`,
        toolReference: `sandbox:node-test:${file}:${item.line ?? 1}`,
        metadata: {
          case: item.name,
          durationMs: item.durationMs,
          failedCases: result.failed,
          mode: result.info.mode,
        },
        extraEvidence: [
          {
            sourceType: "test_result" as const,
            sourceReference: `${file}${item.line ? `:${item.line}` : ""}`,
            snippet: item.message?.slice(0, 400) ?? "test failed",
            metadata: { executed: true, mode: result.info.mode },
          },
        ],
      }),
    );
  }

  for (const crash of result.info.crashed) {
    findings.push(
      makeFinding({
        ruleId: "TST-007",
        path: crash.path,
        line: 1,
        snippet: crash.error,
        confidence: 0.99,
        severityReason: "The file could not be loaded, so none of its tests ran.",
        toolReference: `sandbox:load:${crash.path}`,
        metadata: { mode: result.info.mode },
        extraEvidence: [
          {
            sourceType: "tool_output" as const,
            sourceReference: `sandbox stderr · ${crash.path}`,
            snippet: crash.error,
          },
        ],
      }),
    );
  }

  if (result.status === "timeout" || result.timedOutFile) {
    const file = result.timedOutFile ?? result.info.files[0] ?? "unknown";
    findings.push(
      makeFinding({
        ruleId: "TST-008",
        path: file,
        line: 1,
        snippet: result.notes.join("\n").slice(0, 600),
        confidence: 0.99,
        severityReason: `The suite did not finish within the ${result.info.limits.perFileMs} ms per-file deadline.`,
        toolReference: `sandbox:timeout:${file}`,
        metadata: { perFileMs: result.info.limits.perFileMs, wallMs: result.info.limits.wallMs },
        extraEvidence: [
          {
            sourceType: "test_result" as const,
            sourceReference: `sandbox · ${file}`,
            snippet: "killed at the per-file deadline (SIGKILL)",
          },
        ],
      }),
    );
  }

  const notes = [...result.notes];
  if (failing.length > MAX_FAILURE_FINDINGS) {
    notes.push(`${failing.length} failing cases were reported; the first ${MAX_FAILURE_FINDINGS} became findings.`);
  }

  const testRun: TestRunRecord = {
    framework: "node:test (Node's built-in runner)",
    command: `node --permission (${result.info.files.length} file(s), ${result.info.limits.memoryMb} MB heap, ${result.info.limits.perFileMs} ms/file)`,
    status: "executed",
    executed: true,
    passed: result.passed,
    failed: result.failed,
    skipped: result.skippedCount,
    coveragePercent: null,
    durationMs: result.durationMs,
    outputExcerpt: result.output.slice(0, 6000) || null,
    sourceReference: result.info.files.slice(0, 6).join(", ") || null,
    mode: result.info.mode,
    cases: result.cases.slice(0, 60),
    sandbox: result.info,
    truncated: result.info.truncated || result.cases.length > 60,
  };

  return { findings, testRun, notes, executed: true, result };
}
