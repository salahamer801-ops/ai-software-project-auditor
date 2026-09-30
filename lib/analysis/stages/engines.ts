import { logger } from "../../observability/log";
import {
  ANALYSIS_LIMITS,
  type ArchitectureSummary,
  type AuditStatus,
  type DependencyRecord,
  type EngineId,
  type EngineRunInfo,
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
}

export interface AnalysisStageInput {
  snapshot: RepoSnapshot;
  /** Wall-clock budget (§41): engines stop adding work when it passes. */
  deadline: number;
  move: (stage: AuditStatus, progress: number, detail?: string | null) => Promise<void>;
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
  const { snapshot, deadline, move } = input;
  const engines: EngineRunInfo[] = [];
  const toolsUsed: string[] = [];
  const rawFindings: RawFinding[] = [];

  const runEngine = async (engine: EngineId, fn: () => void | Promise<void>) => {
    const engineStart = Date.now();
    const notes: string[] = [];
    try {
      await fn();
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
  };

  await move("ANALYZING", 26, "quality and duplication metrics");
  await runEngine("quality", () => {
    const collector: RawFinding[] = [];
    const notes: string[] = [];
    const result = runQualityEngine(makeContext(snapshot, collector, notes, deadline));
    rawFindings.push(...result.findings);
    state.quality = result.metrics;
    toolsUsed.push("quality-engine (TypeScript AST + line metrics)");
    void notes;
  });

  await move("SECURITY_SCAN", 42, "secrets, injection patterns and configuration");
  await runEngine("secrets", () => {
    const collector: RawFinding[] = [];
    const notes: string[] = [];
    const found = runSecretsEngine(makeContext(snapshot, collector, notes, deadline));
    rawFindings.push(...found);
    toolsUsed.push("secrets-engine (pattern + entropy, values masked)");
  });
  await runEngine("security", () => {
    const collector: RawFinding[] = [];
    const notes: string[] = [];
    const found = runSecurityEngine(makeContext(snapshot, collector, notes, deadline));
    rawFindings.push(...found);
    toolsUsed.push("security-engine (language-aware static rules)");
  });

  await move("DEPENDENCY_SCAN", 55, "OSV advisories");
  await runEngine("dependencies", async () => {
    const collector: RawFinding[] = [];
    const notes: string[] = [];
    const result = await runDependenciesEngine(makeContext(snapshot, collector, notes, deadline));
    rawFindings.push(...result.findings);
    state.dependencies = result.records;
    state.advisoriesVerified = result.verified;
    toolsUsed.push(`dependencies-engine (${result.advisorySource})`);
    const entry = engines.find((item) => item.engine === "dependencies");
    for (const note of result.notes) entry?.notes.push(note);
    if (!result.verified && entry) entry.status = "skipped";
  });

  await move("TESTING", 66, "committed test and coverage artifacts only");
  await runEngine("tests", () => {
    const collector: RawFinding[] = [];
    const notes: string[] = [];
    const result = runTestsEngine(makeContext(snapshot, collector, notes, deadline));
    rawFindings.push(...result.findings);
    state.testRuns = result.testRuns;
    toolsUsed.push("test-engine (static detection + committed JUnit/coverage parsing)");
    const entry = engines.find((item) => item.engine === "tests");
    for (const note of result.notes) entry?.notes.push(note);
  });

  await runEngine("api", () => {
    const collector: RawFinding[] = [];
    const notes: string[] = [];
    rawFindings.push(...runApiEngine(makeContext(snapshot, collector, notes, deadline)));
    toolsUsed.push("api-engine (route and handler inspection)");
  });

  await runEngine("database", () => {
    const collector: RawFinding[] = [];
    const notes: string[] = [];
    rawFindings.push(...runDatabaseEngine(makeContext(snapshot, collector, notes, deadline)));
    toolsUsed.push("database-engine (migration and schema parsing)");
  });

  await runEngine("ops", () => {
    const collector: RawFinding[] = [];
    const notes: string[] = [];
    rawFindings.push(...runOpsEngine(makeContext(snapshot, collector, notes, deadline)));
    toolsUsed.push("ops-engine (Dockerfile, compose and CI files)");
  });

  await move("ARCHITECTURE", 74, "import graph and cycles");
  await runEngine("architecture", () => {
    const collector: RawFinding[] = [];
    const notes: string[] = [];
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
