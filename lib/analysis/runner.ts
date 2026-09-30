import { newId, query } from "../db";
import { getJob, getProject, getRunByJob, listProjectRuns } from "../queries";
import { RULE_CATALOG } from "../rules/catalog";
import {
  ANALYSIS_LIMITS,
  ENGINE_VERSION,
  RULE_CATALOG_VERSION,
  type AuditStatus,
  type Finding,
} from "../types";
import { ArchiveError } from "../sources/extract";
import { GithubError } from "../sources/github";
import { aiConfigured, aiModel } from "../ai/provider";
import { logger } from "../observability/log";
import { normaliseFindings } from "./evidence";
import { buildAuditSummary, buildLimitations } from "./summary";
import { StageEmitter, isCancelled } from "./state";
import { loadSnapshot } from "./source";
import { runAnalysisStage } from "./stages/engines";
import { runAiStage } from "./stages/ai";
import { persistAudit } from "./stages/persist";
import type { AuditOutcome, ProgressEvent } from "./types";

export type { AuditOutcome, ProgressEvent } from "./types";
export { ALLOWED_TRANSITIONS, STAGE_LABEL, STAGE_SEQUENCE, canTransition, severityOrder } from "./state";

/**
 * The audit pipeline (§14), stage by stage.
 *
 *   source → deterministic engines → evidence layer → explanatory AI → verification → report
 *
 * The stages live in `./stages/*`; this file owns the order, the job state and the failure
 * path. Each step is a database checkpoint, so a reloaded page shows real progress and a
 * crash leaves the job in a state that says what happened.
 */
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

  logger.info("audit.started", {
    jobId,
    runId,
    projectId: project.id,
    sourceType: project.source_type,
    ref: job.ref ?? project.default_branch ?? null,
  });

  // The rule catalogue is versioned with the run (§46), so a report can always say which
  // rules produced it.
  await query(
    `insert into rules_catalog (id, version, payload) values ($1, $2, $3::jsonb)
     on conflict (id) do nothing`,
    [
      `catalog@${RULE_CATALOG_VERSION}`,
      RULE_CATALOG_VERSION,
      JSON.stringify(
        RULE_CATALOG.map((rule) => ({ id: rule.id, version: rule.version, severity: rule.severity, category: rule.category })),
      ),
    ],
  );

  if (!existing) {
    await query(
      `insert into audit_runs (id, audit_job_id, project_id, engine_version, rule_version, ai_model, status)
       values ($1, $2, $3, $4, $5, $6, 'RUNNING')`,
      [runId, jobId, project.id, ENGINE_VERSION, RULE_CATALOG_VERSION, aiConfigured() ? aiModel() : null],
    );
  }

  try {
    /* ------------------------------ stage 2–4: source ------------------------------ */
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

    /* ------------------------------ stage 5–6: stack ------------------------------- */
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

    /* --------------------------- stage 7: deterministic engines -------------------- */
    const analysis = await runAnalysisStage({
      snapshot,
      deadline,
      move: (stage, progress, detail) => emitter.move(stage, progress, detail),
    });

    if (await isCancelled(jobId)) {
      await emitter.move("CANCELLED", 100);
      await query(`update audit_runs set status = 'CANCELLED' where id = $1`, [runId]);
      return { runId, status: "CANCELLED", findings: 0 };
    }

    /* ------------------------- stage 8–10: evidence layer -------------------------- */
    const fileByPath = new Map(snapshot.files.map((file) => [file.path, file]));
    const normalised = normaliseFindings(analysis.rawFindings, {
      runId,
      projectId: project.id,
      snapshot,
      fileByPath,
    });

    // Engine finding counts for the run record.
    for (const engine of analysis.engines) {
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

    /* --------------------------- stage 11: explanatory AI -------------------------- */
    await emitter.move("AI_REVIEW", 84, aiConfigured() ? `model ${aiModel()}` : "rules-engine explanations");
    const ai = await runAiStage({
      findings: normalised.findings,
      snapshot,
      engines: analysis.engines,
      state: analysis.state,
      deadline,
    });

    const summary = buildAuditSummary({
      findings: normalised.findings,
      snapshot,
      engines: analysis.engines,
      aiHeadline: ai.summary?.source === "ai" ? ai.summary.headline : null,
      aiHighlights: ai.summary?.source === "ai" ? ai.summary.highlights : null,
    });

    /* ------------------------ stage 12: verification and limits -------------------- */
    await emitter.move(
      "VERIFYING",
      92,
      `${normalised.findings.length} findings, ${normalised.rejectedReferences.length} references rejected`,
    );
    const limitations = buildLimitations({
      snapshot,
      engines: analysis.engines,
      advisoriesVerified: analysis.state.advisoriesVerified,
      testsExecuted: analysis.state.testsExecuted,
      aiEnabled: aiConfigured(),
      rejectedEvidenceRefs: normalised.rejectedReferences.length + ai.rejections,
      truncated: snapshot.totals.truncated,
    });

    /* ------------------------- stage 13–14: report and persist --------------------- */
    await emitter.move("REPORTING", 96, "persisting audit record");
    const durationMs = await persistAudit({
      runId,
      projectId: project.id,
      organizationId: project.organization_id,
      triggeredBy: job.triggered_by,
      snapshot,
      findings: normalised.findings,
      engines: analysis.engines,
      state: analysis.state,
      summary,
      limitations,
      aiReviews: ai.reviews,
      aiSummary: ai.summary,
      toolsUsed: analysis.toolsUsed,
      startedAt,
    });

    await emitter.move("COMPLETED", 100, `${normalised.findings.length} findings`);
    logger.info("audit.completed", {
      jobId,
      runId,
      findings: normalised.findings.length,
      verdict: summary.status,
      rejectedReferences: normalised.rejectedReferences.length,
      durationMs,
    });

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
    logger.error("audit.failed", {
      jobId,
      runId,
      jobStage: emitter.stage as AuditStatus,
      reason: message,
      error,
    });
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
