import type {
  ArchitectureSummary,
  AuditSummary,
  BilingualText,
  EngineRunInfo,
  QualityMetrics,
  StackInfo,
  TestRunRecord,
} from "./types";
import { ENGINE_VERSION, RULE_CATALOG_VERSION } from "./types";
import { getJob, getProject, getRunByJob, listDependencies, listFindings, listTestRuns } from "./queries";
import { query } from "./db";
import { aiConfigured, aiModel } from "./ai/provider";

export interface ReportFinding {
  id: string;
  ruleId: string;
  ruleVersion: string;
  category: string;
  severity: string;
  confidence: number;
  aiConfidence: number | null;
  severitySource: string;
  severityReason: string | null;
  status: string;
  title: BilingualText;
  description: BilingualText;
  impact: BilingualText;
  recommendation: BilingualText;
  detectionMethod: BilingualText;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  symbol: string | null;
  fingerprint: string;
  toolReference: string | null;
  evidence: { sourceType: string; sourceReference: string; snippet: string | null }[];
  metadata: Record<string, unknown>;
  ai: {
    source: string;
    model: string | null;
    promptVersion: string;
    explanation: BilingualText;
    practicalImpact: BilingualText;
    remediation: BilingualText;
    falsePositiveIndicators: BilingualText;
    limitations: string[];
    evidenceRefs: { file: string; line?: number }[];
    rejectedEvidenceRefs: { file: string; line?: number; reason: string }[];
    verificationOccurred: boolean;
  } | null;
}

export interface AuditReport {
  generatedAt: string;
  product: { name: string; engineVersion: string; ruleVersion: string; aiModel: string | null; aiEnabled: boolean };
  project: {
    id: string;
    name: string;
    sourceType: string;
    repositoryUrl: string | null;
    visibility: string | null;
    organization: string;
  };
  audit: {
    jobId: string;
    runId: string;
    status: string;
    createdAt: string;
    durationMs: number | null;
    commitSha: string | null;
    branch: string | null;
    sourceLabel: string;
  };
  stack: StackInfo | null;
  summary: AuditSummary | null;
  totals: Record<string, number> | null;
  quality: QualityMetrics | null;
  architecture: ArchitectureSummary | null;
  dependencies: {
    total: number;
    vulnerable: number;
    outdated: number;
    items: {
      packageManager: string;
      packageName: string;
      version: string;
      ecosystem: string;
      scope: string;
      latestVersion: string | null;
      vulnerabilities: {
        advisoryId: string;
        severity: string;
        cvss: number | null;
        summary: string;
        fixedVersion: string | null;
        source: string;
      }[];
    }[];
  };
  tests: TestRunRecord[];
  engines: EngineRunInfo[];
  limitations: BilingualText[];
  tools: string[];
  verification: { advisoriesVerified: boolean; testsExecuted: boolean; rejectedReferences: number };
  findings: ReportFinding[];
}

export async function buildReport(jobId: string): Promise<AuditReport | null> {
  const job = await getJob(jobId);
  if (!job) return null;
  const run = await getRunByJob(jobId);
  if (!run) return null;
  const project = await getProject(job.project_id);
  if (!project) return null;

  const [findingRows, dependencyRows, testRuns, aiRows, orgRows] = await Promise.all([
    listFindings(run.id, { limit: 500 }),
    listDependencies(run.id),
    listTestRuns(run.id),
    query<{ finding_id: string | null; result: ReportFinding["ai"]; model: string | null; prompt_version: string }>(
      `select finding_id, result, model, prompt_version from ai_reviews where audit_run_id = $1 and kind = 'finding_explanation'`,
      [run.id],
    ),
    query<{ name: string }>(`select name from organizations where id = $1`, [project.organization_id]),
  ]);

  const evidenceRows = await query<{ finding_id: string; source_type: string; source_reference: string; snippet: string | null }>(
    `select finding_id, source_type, source_reference, snippet from finding_evidence
      where finding_id in (select id from findings where audit_run_id = $1)`,
    [run.id],
  );
  const evidenceByFinding = new Map<string, ReportFinding["evidence"]>();
  for (const row of evidenceRows) {
    const list = evidenceByFinding.get(row.finding_id) ?? [];
    list.push({ sourceType: row.source_type, sourceReference: row.source_reference, snippet: row.snippet });
    evidenceByFinding.set(row.finding_id, list);
  }

  const aiByFinding = new Map(aiRows.map((row) => [row.finding_id ?? "", row]));

  const findings: ReportFinding[] = findingRows.map((finding) => {
    const aiRow = aiByFinding.get(finding.id);
    return {
      id: finding.id,
      ruleId: finding.rule_id,
      ruleVersion: finding.rule_version,
      category: finding.category,
      severity: finding.severity,
      confidence: finding.confidence,
      aiConfidence: finding.ai_confidence,
      severitySource: finding.severity_source,
      severityReason: finding.severity_reason,
      status: finding.status,
      title: finding.title,
      description: finding.description,
      impact: finding.impact,
      recommendation: finding.recommendation,
      detectionMethod: finding.detection_method,
      filePath: finding.file_path,
      lineStart: finding.line_start,
      lineEnd: finding.line_end,
      symbol: finding.symbol,
      fingerprint: finding.fingerprint,
      toolReference: finding.tool_reference,
      evidence: evidenceByFinding.get(finding.id) ?? [],
      metadata: finding.metadata ?? {},
      ai: aiRow
        ? {
            source: aiRow.result?.source ?? "rules_engine",
            model: aiRow.model,
            promptVersion: aiRow.prompt_version,
            explanation: aiRow.result?.explanation ?? { ar: "", en: "" },
            practicalImpact: aiRow.result?.practicalImpact ?? { ar: "", en: "" },
            remediation: aiRow.result?.remediation ?? { ar: "", en: "" },
            falsePositiveIndicators: aiRow.result?.falsePositiveIndicators ?? { ar: "", en: "" },
            limitations: aiRow.result?.limitations ?? [],
            evidenceRefs: aiRow.result?.evidenceRefs ?? [],
            rejectedEvidenceRefs: aiRow.result?.rejectedEvidenceRefs ?? [],
            verificationOccurred: aiRow.result?.verificationOccurred ?? false,
          }
        : null,
    };
  });

  const tools = (run.stats?.totals as Record<string, unknown> | undefined)?.tools as string[] | undefined;
  const statsTotals = run.stats?.totals as Record<string, number> | undefined;
  const vulnerable = dependencyRows.filter((item) => (item.vulnerabilities?.length ?? 0) > 0).length;
  const outdated = dependencyRows.filter((item) => item.outdated).length;

  return {
    generatedAt: new Date().toISOString(),
    product: {
      name: "CodeAudit",
      engineVersion: ENGINE_VERSION,
      ruleVersion: RULE_CATALOG_VERSION,
      aiModel: run.ai_model,
      aiEnabled: aiConfigured() || run.ai_model !== null,
    },
    project: {
      id: project.id,
      name: project.name,
      sourceType: project.source_type,
      repositoryUrl: project.repository_url,
      visibility: project.visibility,
      organization: orgRows[0]?.name ?? "—",
    },
    audit: {
      jobId: job.id,
      runId: run.id,
      status: run.status,
      createdAt: run.created_at,
      durationMs: run.duration_ms,
      commitSha: run.commit_sha ?? job.commit_sha,
      branch: run.branch ?? job.branch,
      sourceLabel: run.source?.label ?? project.repository_url ?? project.source_type,
    },
    stack: run.stack,
    summary: run.summary,
    totals: statsTotals ?? null,
    quality: run.stats?.quality ?? null,
    architecture: run.stats?.architecture ?? null,
    dependencies: {
      total: dependencyRows.length,
      vulnerable,
      outdated,
      items: dependencyRows
        .filter((item) => (item.vulnerabilities?.length ?? 0) > 0 || item.outdated)
        .slice(0, 60)
        .map((item) => ({
          packageManager: item.packageManager,
          packageName: item.packageName,
          version: item.version,
          ecosystem: item.ecosystem,
          scope: item.scope,
          latestVersion: item.latestVersion ?? null,
          vulnerabilities: (item.vulnerabilities ?? []).map((vulnerability) => ({
            advisoryId: vulnerability.advisoryId,
            severity: vulnerability.severity,
            cvss: vulnerability.cvss,
            summary: vulnerability.summary,
            fixedVersion: vulnerability.fixedVersion,
            source: vulnerability.source,
          })),
        })),
    },
    tests: testRuns,
    engines: run.engines ?? [],
    limitations: run.limitations ?? [],
    tools: tools ?? [],
    verification: {
      advisoriesVerified: Boolean((run.stats as { advisoriesVerified?: boolean } | null)?.advisoriesVerified),
      testsExecuted: Boolean((run.stats as { testsExecuted?: boolean } | null)?.testsExecuted),
      rejectedReferences: findings.reduce((sum, finding) => sum + (finding.ai?.rejectedEvidenceRefs.length ?? 0), 0),
    },
    findings,
  };
}
