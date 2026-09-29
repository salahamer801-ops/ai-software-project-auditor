import { newId, query, withTransaction } from "../db";
import { getJob, getProject, getRunByJob, listProjectRuns } from "../queries";
import { RULE_CATALOG } from "../rules/catalog";
import { ENGINE_VERSION, ANALYSIS_LIMITS, RULE_CATALOG_VERSION, type AuditStatus, type BilingualText, type EngineId, type EngineRunInfo, type Finding, type RepoSnapshot, type Severity } from "../types";
import { extractArchive, ArchiveError, type ExtractResult } from "../sources/extract";
import { buildSnapshot } from "../sources/snapshot";
import { demoSnapshot } from "../demo/demo-repo";
import { fetchRepoArchive, GithubError, githubTokenConfigured } from "../sources/github";
import { runSecretsEngine } from "../engines/secrets";
import { runSecurityEngine } from "../engines/security";
import { runDependenciesEngine } from "../engines/dependencies";
import { runQualityEngine } from "../engines/quality";
import { runArchitectureEngine } from "../engines/architecture";
import { runApiEngine } from "../engines/api";
import { runDatabaseEngine } from "../engines/database";
import { runOpsEngine } from "../engines/ops";
import { runTestsEngine } from "../engines/tests";
import { isTestFile, isUiFile } from "../engines/stack";
import type { EngineContext } from "../engines/shared";
import { normaliseFindings } from "./evidence";
import { buildAuditSummary, buildLimitations } from "./summary";
import { aiConfigured, aiModel } from "../ai/provider";
import { reviewFinding, summariseAudit } from "../ai/reviewer";

export interface ProgressEvent {
  stage: AuditStatus;
  progress: number;
  message: BilingualText;
  detail?: string | null;
  at: string;
}

export interface AuditOutcome {
  runId: string | null;
  status: AuditStatus;
  error?: string;
  findings: number;
}

const STAGE_LABEL: Record<string, BilingualText> = {
  QUEUED: { ar: "في الانتظار", en: "Queued" },
  CLONING: { ar: "جلب المستودع وبناء قائمة الملفات", en: "Fetching the repository and building the manifest" },
  DETECTING: { ar: "كشف التقنيات والإطار", en: "Detecting stack and frameworks" },
  ANALYZING: { ar: "التحليل الساكن", en: "Static analysis" },
  SECURITY_SCAN: { ar: "الأمن وكشف الأسرار", en: "Security and secret detection" },
  DEPENDENCY_SCAN: { ar: "فحص التبعيات مقابل التحذيرات الأمنية", en: "Checking dependencies against advisories" },
  TESTING: { ar: "قراءة نتائج الاختبارات والتغطية المرفوعة", en: "Reading committed test and coverage results" },
  ARCHITECTURE: { ar: "تحليل المعمارية والاعتماديات", en: "Architecture and dependency graph" },
  AI_REVIEW: { ar: "الشرح التفسيري وبناء الملخّص", en: "Explanatory review and summary" },
  VERIFYING: { ar: "التحقق من الأدلة والمراجع", en: "Verifying evidence and references" },
  REPORTING: { ar: "إنشاء التقرير", en: "Generating the report" },
  COMPLETED: { ar: "اكتمل التدقيق", en: "Audit completed" },
  FAILED: { ar: "فشل التدقيق", en: "Audit failed" },
  CANCELLED: { ar: "أُلغي التدقيق", en: "Audit cancelled" },
};

/** Allowed job-state transitions (§32). */
export const ALLOWED_TRANSITIONS: Record<string, AuditStatus[]> = {
  QUEUED: ["CLONING", "FAILED", "CANCELLED"],
  CLONING: ["DETECTING", "FAILED", "CANCELLED"],
  DETECTING: ["ANALYZING", "FAILED", "CANCELLED"],
  ANALYZING: ["SECURITY_SCAN", "FAILED", "CANCELLED"],
  SECURITY_SCAN: ["DEPENDENCY_SCAN", "FAILED", "CANCELLED"],
  DEPENDENCY_SCAN: ["TESTING", "FAILED", "CANCELLED"],
  TESTING: ["ARCHITECTURE", "FAILED", "CANCELLED"],
  ARCHITECTURE: ["AI_REVIEW", "FAILED", "CANCELLED"],
  AI_REVIEW: ["VERIFYING", "FAILED", "CANCELLED"],
  VERIFYING: ["REPORTING", "FAILED", "CANCELLED"],
  REPORTING: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

class StageEmitter {
  private current: AuditStatus = "QUEUED";
  private stages: { stage: AuditStatus; at: string; detail?: string | null }[] = [];
  constructor(private jobId: string, private onProgress: (event: ProgressEvent) => void) {}

  async move(stage: AuditStatus, progress: number, detail?: string | null): Promise<void> {
    if (stage !== this.current) {
      const allowed = ALLOWED_TRANSITIONS[this.current] ?? [];
      if (allowed.length > 0 && !allowed.includes(stage)) {
        // Never let a stage jump happen silently.
        throw new Error(`invalid_transition:${this.current}->${stage}`);
      }
    }
    this.current = stage;
    this.stages.push({ stage, at: new Date().toISOString(), detail: detail ?? null });
    const event: ProgressEvent = {
      stage,
      progress,
      message: STAGE_LABEL[stage] ?? { ar: stage, en: stage },
      detail: detail ?? null,
      at: new Date().toISOString(),
    };
    this.onProgress(event);
    await query(
      `update audit_jobs set status = $2, progress = $3, stages = $4::jsonb,
             started_at = coalesce(started_at, now()) where id = $1`,
      [this.jobId, stage, progress, JSON.stringify(this.stages)],
    );
  }

  snapshot(): { stage: AuditStatus; stages: { stage: AuditStatus; at: string; detail?: string | null }[] } {
    return { stage: this.current, stages: this.stages };
  }
}

async function isCancelled(jobId: string): Promise<boolean> {
  const rows = await query<{ status: string }>(`select status from audit_jobs where id = $1`, [jobId]);
  return rows[0]?.status === "CANCELLED";
}

async function loadSnapshot(projectId: string, sourceType: string, repoOwner: string | null, repoName: string | null, ref: string | null): Promise<{ snapshot: RepoSnapshot; extract: ExtractResult | null }> {
  if (sourceType === "demo") {
    return { snapshot: demoSnapshot(), extract: null };
  }
  if (sourceType === "github") {
    if (!repoOwner || !repoName) throw new Error("repository_missing");
    const token = githubTokenConfigured() ? process.env.GITHUB_TOKEN!.trim() : null;
    const archive = await fetchRepoArchive({ owner: repoOwner, repo: repoName, ref }, token);
    const extract = extractArchive(archive.buffer, "repository.tar.gz", {
      maxEntries: ANALYSIS_LIMITS.maxFiles,
      maxTotalBytes: 40 * 1024 * 1024,
    });
    const snapshot = buildSnapshot(
      extract.entries,
      {
        type: "github",
        label: `${archive.repositoryUrl}@${archive.revision}`,
        repositoryUrl: archive.repositoryUrl,
        owner: repoOwner,
        repo: repoName,
        ref: archive.revision,
        commitSha: archive.commitSha ?? undefined,
        bytes: archive.buffer.length,
      },
      extract.skipped,
      ANALYSIS_LIMITS,
    );
    return { snapshot, extract };
  }

  // Uploaded archive, stored with the project so the audit can be re-run later.
  const rows = await query<{ bytes: Buffer; filename: string | null }>(
    `select bytes, filename from project_sources where project_id = $1 order by created_at desc limit 1`,
    [projectId],
  );
  const row = rows[0];
  if (!row?.bytes) throw new Error("no_source_archive");
  const extract = extractArchive(Buffer.from(row.bytes), row.filename ?? "project.zip", {
    maxEntries: ANALYSIS_LIMITS.maxFiles,
    maxTotalBytes: 40 * 1024 * 1024,
  });
  const snapshot = buildSnapshot(
    extract.entries,
    {
      type: "upload",
      label: row.filename ?? "uploaded archive",
      ref: ref ?? "upload",
      bytes: row.bytes.length,
    },
    extract.skipped,
    ANALYSIS_LIMITS,
  );
  return { snapshot, extract };
}

function makeContext(
  snapshot: RepoSnapshot,
  findings: { push: (finding: import("../types").RawFinding) => void },
  notes: string[],
  deadline: number,
): EngineContext {
  return {
    snapshot,
    files: snapshot.files.filter((file) => file.text && typeof file.content === "string"),
    emit: findings.push,
    note: (message: string) => notes.push(message),
    deadline,
  };
}

export async function executeAudit(
  jobId: string,
  onProgress: (event: ProgressEvent) => void = () => undefined,
): Promise<AuditOutcome> {
  const job = await getJob(jobId);
  if (!job) return { runId: null, status: "FAILED", error: "job_not_found", findings: 0 };
  const project = await getProject(job.project_id);
  if (!project) return { runId: null, status: "FAILED", error: "project_not_found", findings: 0 };

  const existing = await getRunByJob(jobId);
  if (existing && job.status === "COMPLETED") {
    return { runId: existing.id, status: "COMPLETED", findings: existing.summary?.totalFindings ?? 0 };
  }
  if (job.status === "CANCELLED") {
    return { runId: existing?.id ?? null, status: "CANCELLED", findings: 0 };
  }

  const emitter = new StageEmitter(jobId, onProgress);
  const runId = existing?.id ?? newId("run");
  const startedAt = Date.now();
  const deadline = startedAt + ANALYSIS_LIMITS.maxTimeMs;

  await query(
    `insert into rules_catalog (id, version, payload) values ($1, $2, $3::jsonb)
     on conflict (id) do nothing`,
    [`catalog@${RULE_CATALOG_VERSION}`, RULE_CATALOG_VERSION, JSON.stringify(RULE_CATALOG.map((rule) => ({ id: rule.id, version: rule.version, severity: rule.severity, category: rule.category })))],
  );

  if (!existing) {
    await query(
      `insert into audit_runs (id, audit_job_id, project_id, engine_version, rule_version, ai_model, status)
       values ($1, $2, $3, $4, $5, $6, 'RUNNING')`,
      [runId, jobId, project.id, ENGINE_VERSION, RULE_CATALOG_VERSION, aiConfigured() ? aiModel() : null],
    );
  }

  try {
    /* ------------------------------ source ------------------------------ */
    await emitter.move("CLONING", 8, project.repository_url ?? project.source_type);
    const { snapshot } = await loadSnapshot(
      project.id,
      project.source_type,
      project.repo_owner,
      project.repo_name,
      job.ref ?? project.default_branch,
    );

    if (await isCancelled(jobId)) {
      await emitter.move("CANCELLED", 100);
      await query(`update audit_runs set status = 'CANCELLED' where id = $1`, [runId]);
      return { runId, status: "CANCELLED", findings: 0 };
    }

    await emitter.move(
      "DETECTING",
      16,
      `${snapshot.totals.textFileCount} text files · ${snapshot.stack.languages.slice(0, 3).map((lang) => lang.name).join(", ")}`,
    );

    await query(
      `update projects set language = $2, framework = $3, updated_at = now() where id = $1`,
      [
        project.id,
        snapshot.stack.languages[0]?.name ?? null,
        snapshot.stack.frameworks.slice(0, 3).join(", ") || null,
      ],
    );
    if (snapshot.source.commitSha) {
      await query(`update audit_jobs set commit_sha = $2, branch = $3 where id = $1`, [
        jobId,
        snapshot.source.commitSha,
        snapshot.source.ref ?? null,
      ]);
    }

    const engines: EngineRunInfo[] = [];
    const toolsUsed: string[] = [];
    const rawFindings: import("../types").RawFinding[] = [];

    const runEngine = async (engine: EngineId, fn: () => void | Promise<void>) => {
      const engineStart = Date.now();
      const notes: string[] = [];
      try {
        await fn();
        engines.push({ engine, status: "ok", durationMs: Date.now() - engineStart, findings: 0, notes });
      } catch (error) {
        engines.push({
          engine,
          status: "error",
          durationMs: Date.now() - engineStart,
          findings: 0,
          notes,
          error: error instanceof Error ? error.message : "engine_failed",
        });
      }
    };

    /* ---------------------------- analysis ------------------------------ */
    const state = {
      quality: null as import("../types").QualityMetrics | null,
      architecture: null as import("../types").ArchitectureSummary | null,
      dependencies: [] as import("../types").DependencyRecord[],
      testRuns: [] as import("../types").TestRunRecord[],
      advisoriesVerified: true,
      testsExecuted: false,
    };

    await emitter.move("ANALYZING", 26, "quality and duplication metrics");
    await runEngine("quality", () => {
      const collector: import("../types").RawFinding[] = [];
      const notes: string[] = [];
      const result = runQualityEngine(makeContext(snapshot, collector, notes, deadline));
      rawFindings.push(...result.findings);
      state.quality = result.metrics;
      toolsUsed.push("quality-engine (TypeScript AST + line metrics)");
      void notes;
    });

    await emitter.move("SECURITY_SCAN", 42, "secrets, injection patterns and configuration");
    await runEngine("secrets", () => {
      const collector: import("../types").RawFinding[] = [];
      const notes: string[] = [];
      const found = runSecretsEngine(makeContext(snapshot, collector, notes, deadline));
      rawFindings.push(...found);
      toolsUsed.push("secrets-engine (pattern + entropy, values masked)");
    });
    await runEngine("security", () => {
      const collector: import("../types").RawFinding[] = [];
      const notes: string[] = [];
      const found = runSecurityEngine(makeContext(snapshot, collector, notes, deadline));
      rawFindings.push(...found);
      toolsUsed.push("security-engine (language-aware static rules)");
    });

    await emitter.move("DEPENDENCY_SCAN", 55, "OSV advisories");
    await runEngine("dependencies", async () => {
      const collector: import("../types").RawFinding[] = [];
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

    await emitter.move("TESTING", 66, "committed test and coverage artifacts only");
    await runEngine("tests", () => {
      const collector: import("../types").RawFinding[] = [];
      const notes: string[] = [];
      const result = runTestsEngine(makeContext(snapshot, collector, notes, deadline));
      rawFindings.push(...result.findings);
      state.testRuns = result.testRuns;
      toolsUsed.push("test-engine (static detection + committed JUnit/coverage parsing)");
      const entry = engines.find((item) => item.engine === "tests");
      for (const note of result.notes) entry?.notes.push(note);
    });

    await runEngine("api", () => {
      const collector: import("../types").RawFinding[] = [];
      const notes: string[] = [];
      rawFindings.push(...runApiEngine(makeContext(snapshot, collector, notes, deadline)));
      toolsUsed.push("api-engine (route and handler inspection)");
    });

    await runEngine("database", () => {
      const collector: import("../types").RawFinding[] = [];
      const notes: string[] = [];
      rawFindings.push(...runDatabaseEngine(makeContext(snapshot, collector, notes, deadline)));
      toolsUsed.push("database-engine (migration and schema parsing)");
    });

    await runEngine("ops", () => {
      const collector: import("../types").RawFinding[] = [];
      const notes: string[] = [];
      rawFindings.push(...runOpsEngine(makeContext(snapshot, collector, notes, deadline)));
      toolsUsed.push("ops-engine (Dockerfile, compose and CI files)");
    });

    await emitter.move("ARCHITECTURE", 74, "import graph and cycles");
    await runEngine("architecture", () => {
      const collector: import("../types").RawFinding[] = [];
      const notes: string[] = [];
      const result = runArchitectureEngine(makeContext(snapshot, collector, notes, deadline));
      rawFindings.push(...result.findings);
      state.architecture = result.summary;
      toolsUsed.push("architecture-engine (import graph, cycle detection)");
    });

    if (await isCancelled(jobId)) {
      await emitter.move("CANCELLED", 100);
      await query(`update audit_runs set status = 'CANCELLED' where id = $1`, [runId]);
      return { runId, status: "CANCELLED", findings: 0 };
    }

    /* --------------------------- evidence layer -------------------------- */
    const fileByPath = new Map(snapshot.files.map((file) => [file.path, file]));
    const normalised = normaliseFindings(rawFindings, {
      runId,
      projectId: project.id,
      snapshot,
      fileByPath,
    });

    // Engine finding counts for the run record.
    for (const engine of engines) {
      engine.findings = normalised.findings.filter((finding) => finding.engine === engine.engine).length;
    }

    // Previously recorded decisions (§47) are re-applied so a false-positive mark survives.
    const decisions = await query<{ fingerprint: string; decision: string; reason: string | null }>(
      `select fingerprint, decision, reason from finding_decisions where project_id = $1`,
      [project.id],
    );
    const decisionMap = new Map(decisions.map((row) => [row.fingerprint, row]));
    for (const finding of normalised.findings) {
      const decision = decisionMap.get(finding.fingerprint);
      if (decision && ["false_positive", "ignored", "fixed", "confirmed"].includes(decision.decision)) {
        finding.status = decision.decision as Finding["status"];
        finding.statusReason = decision.reason;
      }
    }

    await emitter.move("AI_REVIEW", 84, aiConfigured() ? `model ${aiModel()}` : "rules-engine explanations");

    const fileContents = new Map(snapshot.files.filter((file) => file.text).map((file) => [file.path, file.content ?? ""]));
    const reviewBudget = Number(process.env.AI_MAX_FINDINGS ?? "8");
    let aiRejections = 0;
    const reviewTargets = normalised.findings
      .filter((finding) => finding.severity === "CRITICAL" || finding.severity === "HIGH" || finding.severity === "MEDIUM")
      .slice(0, Math.max(1, Math.min(reviewBudget, 12)));
    const aiReviews: {
      id: string;
      findingId: string;
      explanation: import("../types").AiExplanation;
      model: string | null;
      promptVersion: string;
      usage: { promptTokens: number | null; completionTokens: number | null } | null;
    }[] = [];

    for (const finding of reviewTargets) {
      if (Date.now() > deadline + 20_000) break;
      const { explanation } = await reviewFinding(finding, snapshot, fileContents);
      finding.aiConfidence = explanation.confidence;
      aiRejections += explanation.rejectedEvidenceRefs.length;
      aiReviews.push({
        id: newId("air"),
        findingId: finding.id,
        explanation,
        model: explanation.model,
        promptVersion: explanation.promptVersion,
        usage: null,
      });
    }

    const aiSummary = await summariseAudit(
      normalised.findings,
      snapshot,
      engines.map((engine) => `${engine.engine}:${engine.status}`).join(", "),
      state.quality ? JSON.stringify(state.quality) : "{}",
    );

    if (aiSummary) aiRejections += aiSummary.limitations.length;

    const summary = buildAuditSummary({
      findings: normalised.findings,
      snapshot,
      engines,
      aiHeadline: aiSummary?.source === "ai" ? aiSummary.headline : null,
      aiHighlights: aiSummary?.source === "ai" ? aiSummary.highlights : null,
    });

    await emitter.move("VERIFYING", 92, `${normalised.findings.length} findings, ${normalised.rejectedReferences.length} references rejected`);
    const limitations = buildLimitations({
      snapshot,
      engines,
      advisoriesVerified: state.advisoriesVerified,
      testsExecuted: state.testsExecuted,
      aiEnabled: aiConfigured(),
      rejectedEvidenceRefs: normalised.rejectedReferences.length + aiRejections,
      truncated: snapshot.totals.truncated,
    });

    /* ------------------------------ persist ----------------------------- */
    await emitter.move("REPORTING", 96, "persisting audit record");

    await withTransaction(async (client) => {
      for (const finding of normalised.findings) {
        await client.query(
          `insert into findings (
             id, audit_run_id, project_id, rule_id, rule_version, engine, category, severity, severity_source, severity_reason,
             confidence, detection_confidence, ai_confidence, title, description, impact, recommendation, status, status_reason,
             file_path, line_start, line_end, symbol, evidence, detection_method, tool_reference, fingerprint, metadata
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19,$20,$21,$22,$23,$24::jsonb,$25::jsonb,$26,$27,$28::jsonb)
           on conflict (id) do nothing`,
          [
            finding.id,
            runId,
            project.id,
            finding.ruleId,
            finding.ruleVersion,
            finding.engine,
            finding.category,
            finding.severity,
            finding.severitySource,
            finding.severityReason,
            finding.confidence,
            finding.detectionConfidence,
            finding.aiConfidence,
            JSON.stringify(finding.title),
            JSON.stringify(finding.description),
            JSON.stringify(finding.impact),
            JSON.stringify(finding.recommendation),
            finding.status,
            finding.statusReason,
            finding.filePath,
            finding.lineStart,
            finding.lineEnd,
            finding.symbol,
            JSON.stringify(finding.evidence.slice(0, 8)),
            JSON.stringify(finding.detectionMethod),
            finding.toolReference,
            finding.fingerprint,
            JSON.stringify(finding.metadata),
          ],
        );
        for (const evidence of finding.evidence.slice(0, 6)) {
          await client.query(
            `insert into finding_evidence (id, finding_id, source_type, source_reference, snippet, metadata)
             values ($1,$2,$3,$4,$5,$6::jsonb)`,
            [
              newId("evd"),
              finding.id,
              evidence.sourceType,
              evidence.sourceReference.slice(0, 400),
              evidence.snippet ?? null,
              JSON.stringify(evidence.metadata ?? {}),
            ],
          );
        }
      }

      for (const record of state.dependencies) {
        const dependencyId = newId("dep");
        await client.query(
          `insert into dependencies (id, audit_run_id, package_manager, package_name, version, ecosystem, scope, manifest_path, vulnerability_count, latest_version, outdated)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            dependencyId,
            runId,
            record.packageManager,
            record.packageName.slice(0, 200),
            record.version.slice(0, 80),
            record.ecosystem,
            record.scope,
            record.manifestPath,
            record.vulnerabilities?.length ?? 0,
            record.latestVersion ?? null,
            record.outdated ?? null,
          ],
        );
        for (const vulnerability of record.vulnerabilities ?? []) {
          await client.query(
            `insert into vulnerabilities (id, dependency_id, advisory_id, severity, cvss, summary, description, fixed_version, source, published_at, advisory_references)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
            [
              newId("vul"),
              dependencyId,
              vulnerability.advisoryId,
              vulnerability.severity,
              vulnerability.cvss,
              vulnerability.summary.slice(0, 500),
              vulnerability.description.slice(0, 2000),
              vulnerability.fixedVersion,
              vulnerability.source,
              vulnerability.publishedAt,
              JSON.stringify(vulnerability.references),
            ],
          );
        }
      }

      for (const run of state.testRuns) {
        await client.query(
          `insert into test_runs (id, audit_run_id, framework, command, status, executed, passed, failed, skipped, coverage, duration_ms, output_excerpt, source_reference)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            newId("tst"),
            runId,
            run.framework,
            run.command,
            run.status,
            run.executed,
            run.passed,
            run.failed,
            run.skipped,
            run.coveragePercent,
            run.durationMs,
            run.outputExcerpt,
            run.sourceReference,
          ],
        );
      }

      const nodes = snapshot.files.slice(0, 600);
      for (const file of nodes) {
        const type = isTestFile(file.path)
          ? "test"
          : isUiFile(file.path)
            ? "ui"
            : /(^|\/)(routes?|controllers?|api)(\/|$)/i.test(file.path)
              ? "api"
              : /(^|\/)(models?|migrations?|db|database)(\/|$)/i.test(file.path)
                ? "data"
                : "module";
        await client.query(
          `insert into architecture_nodes (id, audit_run_id, path, type, language, metadata)
           values ($1,$2,$3,$4,$5,$6::jsonb)`,
          [newId("arc"), runId, file.path, type, file.language, JSON.stringify({ loc: file.loc })],
        );
      }
      for (const edge of (state.architecture?.graph ?? []).slice(0, 500)) {
        await client.query(
          `insert into architecture_edges (id, audit_run_id, source_path, target_path, relationship)
           values ($1,$2,$3,$4,'imports')`,
          [newId("edg"), runId, edge.source, edge.target],
        );
      }

      for (const review of aiReviews) {
        await client.query(
          `insert into ai_reviews (id, audit_run_id, finding_id, model, prompt_version, kind, result, confidence, token_usage, evidence_refs, limitations, rejected_evidence_refs)
           values ($1,$2,$3,$4,$5,'finding_explanation',$6::jsonb,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb)`,
          [
            review.id,
            runId,
            review.findingId,
            review.model,
            review.promptVersion,
            JSON.stringify(review.explanation),
            review.explanation.confidence,
            JSON.stringify(review.usage ?? {}),
            JSON.stringify(review.explanation.evidenceRefs),
            JSON.stringify(review.explanation.limitations),
            JSON.stringify(review.explanation.rejectedEvidenceRefs),
          ],
        );
      }

      if (aiSummary) {
        await client.query(
          `insert into ai_reviews (id, audit_run_id, finding_id, model, prompt_version, kind, result, confidence, token_usage, evidence_refs, limitations, rejected_evidence_refs)
           values ($1,$2,null,$3,$4,'audit_summary',$5::jsonb,$6,$7::jsonb,$8::jsonb,$9::jsonb,'[]'::jsonb)`,
          [
            newId("air"),
            runId,
            aiSummary.model,
            aiSummary.promptVersion,
            JSON.stringify({ headline: aiSummary.headline, highlights: aiSummary.highlights, source: aiSummary.source }),
            0.8,
            JSON.stringify(aiSummary.usage ?? {}),
            JSON.stringify([]),
            JSON.stringify(aiSummary.limitations),
          ],
        );
      }

      const durationMs = Date.now() - startedAt;
      await client.query(
        `update audit_runs set status = 'COMPLETED', stack = $2::jsonb, stats = $3::jsonb, summary = $4::jsonb,
               limitations = $5::jsonb, engines = $6::jsonb, source = $7::jsonb, commit_sha = $8, branch = $9,
               duration_ms = $10, ai_model = $11
         where id = $1`,
        [
          runId,
          JSON.stringify(snapshot.stack),
          JSON.stringify({
            quality: state.quality,
            architecture: state.architecture,
            totals: snapshot.totals,
            tools: toolsUsed,
            advisoriesVerified: state.advisoriesVerified,
            testsExecuted: state.testsExecuted,
          }),
          JSON.stringify(summary),
          JSON.stringify(limitations),
          JSON.stringify(engines),
          JSON.stringify(snapshot.source),
          snapshot.source.commitSha ?? null,
          snapshot.source.ref ?? null,
          durationMs,
          aiConfigured() ? aiModel() : null,
        ],
      );

      await client.query(
        `insert into reports (id, audit_run_id, format, payload) values ($1,$2,'html',$3::jsonb)`,
        [newId("rpt"), runId, JSON.stringify({ generatedBy: `engine ${ENGINE_VERSION}`, ruleVersion: RULE_CATALOG_VERSION })],
      );

      await client.query(
        `insert into audit_events (id, organization_id, user_id, project_id, action, metadata)
         values ($1,$2,$3,$4,'audit.completed',$5::jsonb)`,
        [
          newId("evt"),
          project.organization_id,
          job.triggered_by,
          project.id,
          JSON.stringify({ runId, findings: normalised.findings.length, durationMs }),
        ],
      );
    });

    await emitter.move("COMPLETED", 100, `${normalised.findings.length} findings`);

    return { runId, status: "COMPLETED", findings: normalised.findings.length };
  } catch (error) {
    const message =
      error instanceof GithubError
        ? `github:${error.code}`
        : error instanceof ArchiveError
          ? `archive:${error.message}`
          : error instanceof Error
            ? error.message
            : "unknown_error";
    emitter.move("FAILED", 100, message).catch(() => undefined);
    await query(
      `update audit_runs set status = 'FAILED', stats = coalesce(stats, '{}'::jsonb) || $2::jsonb where id = $1`,
      [runId, JSON.stringify({ failure: message })],
    ).catch(() => undefined);
    await query(`update audit_jobs set status = 'FAILED', error_message = $2, completed_at = now() where id = $1`, [
      jobId,
      message.slice(0, 500),
    ]).catch(() => undefined);
    return { runId, status: "FAILED", error: message, findings: 0 };
  }
}

export async function historyFor(projectId: string) {
  return listProjectRuns(projectId);
}

export function severityOrder(severity: Severity): number {
  return ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].indexOf(severity);
}
