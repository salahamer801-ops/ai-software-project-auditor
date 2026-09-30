import { logger } from "../../observability/log";
import {
  ANALYSIS_LIMITS,
  type ArchitectureSummary,
  type AuditJobOptions,
  type AuditStatus,
  type DependencyRecord,
  type EngineId,
  type EngineRunInfo,
  type ExecutionSummary,
  type QualityMetrics,
  type RawFinding,
  type RepoSnapshot,
  type TestRunRecord,
} from "../../types";
import { runApiEngine } from "../../engines/api";
import { runArchitectureEngine } from "../../engines/architecture";
import { runDatabaseEngine } from "../../engines/database";
import { runDependenciesEngine } from "../../engines/dependencies";
import { runOpsEngine } from "../../engines/ops";
import { runQualityEngine } from "../../engines/quality";
import { runSecretsEngine } from "../../engines/secrets";
import { runSecurityEngine } from "../../engines/security";
import { runExecutionEngine } from "../../engines/execution";
import { runTestsEngine } from "../../engines/tests";
import { makeContext } from "../source";

/** Everything the deterministic engines produce, carried into the evidence and report stages. */
export interface AuditState {
  quality: QualityMetrics | null;
  architecture: ArchitectureSummary | null;
  dependencies: DependencyRecord[];
  testRuns: TestRunRecord[];
  advisoriesVerified: boolean;
  testsExecuted: boolean;
  /** Present once the TESTING stage has run; says whether execution was asked for and what happened. */
  execution: ExecutionSummary | null;
}

const NO_EXECUTION: ExecutionSummary = {
  requested: false,
  executed: false,
  status: "disabled",
  mode: "restricted-process",
  files: 0,
  skipped: 0,
  crashed: 0,
  limits: {
    wallMs: ANALYSIS_LIMITS.sandbox.wallMs,
    perFileMs: ANALYSIS_LIMITS.sandbox.perFileMs,
    memoryMb: ANALYSIS_LIMITS.sandbox.memoryMb,
    maxFiles: ANALYSIS_LIMITS.sandbox.maxFiles,
    maxOutputBytes: ANALYSIS_LIMITS.sandbox.maxOutputBytes,
  },
  notes: [],
};

export interface AnalysisStageInput {
  snapshot: RepoSnapshot;
  /** Wall-clock budget (§41): engines stop adding work when it passes. */
  deadline: number;
  move: (stage: AuditStatus, progress: number, detail?: string | null) => Promise<void>;
  /** The job's own choices: executing project code is opt-in per audit. */
  options: AuditJobOptions;
}

export interface AnalysisStageResult {
  engines: EngineRunInfo[];
  toolsUsed: string[];
  rawFindings: RawFinding[];
  state: AuditState;
}

/**
 * Stage 7 (§14): run every deterministic engine over the manifest.
 *
 * One engine failing never stops the audit — it is recorded as `error` with its own note, and
 * the report says so. Nothing here executes project code (§56).
 */
export async function runAnalysisStage(input: AnalysisStageInput): Promise<AnalysisStageResult> {
  const { snapshot, deadline, move, options } = input;
  const engines: EngineRunInfo[] = [];
  const toolsUsed: string[] = [];
  const rawFindings: RawFinding[] = [];

  const runEngine = async (engine: EngineId, fn: (notes: string[]) => void | Promise<void>) => {
    const engineStart = Date.now();
    const notes: string[] = [];
    try {
      await fn(notes);
      const durationMs = Date.now() - engineStart;
      engines.push({ engine, status: "ok", durationMs, findings: 0, notes });
      logger.info("audit.engine", { engine, status: "ok", durationMs });
    } catch (error) {
      const durationMs = Date.now() - engineStart;
      engines.push({
        engine,
        status: "error",
        durationMs,
        findings: 0,
        notes,
        error: error instanceof Error ? error.message : "engine_failed",
      });
      logger.error("audit.engine", { engine, status: "error", durationMs, error });
    }
  };

  const state: AuditState = {
    quality: null,
    architecture: null,
    dependencies: [],
    testRuns: [],
    advisoriesVerified: true,
    testsExecuted: false,
    execution: NO_EXECUTION,
  };

  await move("ANALYZING", 26, "quality and duplication metrics");
  await runEngine("quality", (notes) => {
    const collector: RawFinding[] = [];
    const result = runQualityEngine(makeContext(snapshot, collector, notes, deadline));
    rawFindings.push(...result.findings);
    state.quality = result.metrics;
    toolsUsed.push("quality-engine (TypeScript AST + line metrics)");
  });

  await move("SECURITY_SCAN", 42, "secrets, injection patterns and configuration");
  await runEngine("secrets", (notes) => {
    const collector: RawFinding[] = [];
    const found = runSecretsEngine(makeContext(snapshot, collector, notes, deadline));
    rawFindings.push(...found);
    toolsUsed.push("secrets-engine (pattern + entropy, values masked)");
  });
  await runEngine("security", (notes) => {
    const collector: RawFinding[] = [];
    const found = runSecurityEngine(makeContext(snapshot, collector, notes, deadline));
    rawFindings.push(...found);
    toolsUsed.push("security-engine (language-aware static rules)");
  });

  await move("DEPENDENCY_SCAN", 55, "OSV advisories");
  await runEngine("dependencies", async (notes) => {
    const collector: RawFinding[] = [];
    const result = await runDependenciesEngine(makeContext(snapshot, collector, notes, deadline));
    rawFindings.push(...result.findings);
    state.dependencies = result.records;
    state.advisoriesVerified = result.verified;
    toolsUsed.push(`dependencies-engine (${result.advisorySource})`);
    // Notes from the engine's own return value join the ones it pushed through the context.
    notes.push(...result.notes);
  });

  /* --------------------- stage: tests, static and executed (§23, §24) ------------- */
  await move(
    "TESTING",
    66,
    options.runTests ? "static detection, then a restricted test run" : "committed test and coverage artifacts only",
  );
  await runEngine("tests", async (notes) => {
    const collector: RawFinding[] = [];
    const result = runTestsEngine(makeContext(snapshot, collector, notes, deadline));
    rawFindings.push(...result.findings);
    state.testRuns = result.testRuns;
    notes.push(...result.notes);
    toolsUsed.push("test-engine (static detection + committed JUnit/coverage parsing)");

    // Execution is the only step that ever runs code from the audited project, so it is
    // opt-in and it never gets more time than the audit's own remaining budget can afford:
    // the AI review and the report still have to run after it (§41).
    if (!options.runTests) return;
    const budget = Math.max(3_000, Math.min(ANALYSIS_LIMITS.sandbox.wallMs, deadline - Date.now() - 12_000));
    const execution = await runExecutionEngine(snapshot, { enabled: true, budgetMs: budget });
    rawFindings.push(...execution.findings);
    if (execution.testRun) state.testRuns.push(execution.testRun);
    state.testsExecuted = execution.executed;
    state.execution = {
      requested: true,
      executed: execution.executed,
      status: execution.result.status,
      mode: execution.result.info.mode,
      files: execution.result.info.files.length,
      skipped: execution.result.info.skipped.length,
      crashed: execution.result.info.crashed.length,
      limits: execution.result.info.limits,
      notes: execution.notes,
    };
    notes.push(...execution.notes);
    if (execution.executed) toolsUsed.push("execution-sandbox (node --permission, guarded network, scrubbed env)");
  });

  await runEngine("api", (notes) => {
    const collector: RawFinding[] = [];
    rawFindings.push(...runApiEngine(makeContext(snapshot, collector, notes, deadline)));
    toolsUsed.push("api-engine (route and handler inspection)");
  });

  await runEngine("database", (notes) => {
    const collector: RawFinding[] = [];
    rawFindings.push(...runDatabaseEngine(makeContext(snapshot, collector, notes, deadline)));
    toolsUsed.push("database-engine (migration and schema parsing)");
  });

  await runEngine("ops", (notes) => {
    const collector: RawFinding[] = [];
    rawFindings.push(...runOpsEngine(makeContext(snapshot, collector, notes, deadline)));
    toolsUsed.push("ops-engine (Dockerfile, compose and CI files)");
  });

  await move("ARCHITECTURE", 74, "import graph and cycles");
  await runEngine("architecture", (notes) => {
    const collector: RawFinding[] = [];
    const result = runArchitectureEngine(makeContext(snapshot, collector, notes, deadline));
    rawFindings.push(...result.findings);
    state.architecture = result.summary;
    toolsUsed.push("architecture-engine (import graph, cycle detection)");
  });

  logger.info("audit.engines.summary", {
    engines: engines.map((engine) => `${engine.engine}:${engine.status}`),
    rawFindings: rawFindings.length,
    truncated: snapshot.totals.truncated,
    limitMs: ANALYSIS_LIMITS.maxTimeMs,
  });

  return { engines, toolsUsed, rawFindings, state };
}
