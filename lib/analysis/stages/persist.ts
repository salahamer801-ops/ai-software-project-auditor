import { newId, withTransaction } from "../../db";
import { logger } from "../../observability/log";
import { ENGINE_VERSION, RULE_CATALOG_VERSION, type AuditSummary, type BilingualText, type EngineRunInfo, type Finding, type RepoSnapshot } from "../../types";
import { isTestFile, isUiFile } from "../../engines/stack";
import { aiConfigured, aiModel } from "../../ai/provider";
import type { AuditAiSummary } from "../../ai/reviewer";
import type { AiReviewRecord } from "./ai";
import type { AuditState } from "./engines";

export interface PersistInput {
  runId: string;
  projectId: string;
  organizationId: string;
  triggeredBy: string | null;
  snapshot: RepoSnapshot;
  findings: Finding[];
  engines: EngineRunInfo[];
  state: AuditState;
  summary: AuditSummary;
  limitations: BilingualText[];
  aiReviews: AiReviewRecord[];
  aiSummary: AuditAiSummary | null;
  toolsUsed: string[];
  startedAt: number;
}

/**
 * Stage 14 (§14): write the audit as one immutable record — findings with their evidence,
 * dependencies with their advisories, test runs, the architecture graph, AI reviews and the
 * completion event. One transaction: a half-written audit can never be read as a whole one.
 */
export async function persistAudit(input: PersistInput): Promise<number> {
  const {
    runId,
    projectId,
    organizationId,
    triggeredBy,
    snapshot,
    findings,
    engines,
    state,
    summary,
    limitations,
    aiReviews,
    aiSummary,
    toolsUsed,
    startedAt,
  } = input;

  await withTransaction(async (client) => {
    for (const finding of findings) {
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
          projectId,
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
        organizationId,
        triggeredBy,
        projectId,
        JSON.stringify({ runId, findings: findings.length, durationMs }),
      ],
    );
  });

  const durationMs = Date.now() - startedAt;
  logger.info("audit.persisted", {
    runId,
    projectId,
    findings: findings.length,
    dependencies: state.dependencies.length,
    aiReviews: aiReviews.length,
    verdict: summary.status,
    durationMs,
  });
  return durationMs;
}
