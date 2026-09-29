import { query } from "./db";
import type {
  AiExplanation,
  ArchitectureSummary,
  AuditSummary,
  BilingualText,
  DependencyRecord,
  EngineRunInfo,
  Finding,
  FindingStatus,
  QualityMetrics,
  RepoSnapshot,
  Severity,
  StackInfo,
  TestRunRecord,
  VulnerabilityRecord,
} from "./types";

/* ----------------------------- row shapes ---------------------------- */

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  source_type: string;
  repository_url: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  default_branch: string | null;
  visibility: string | null;
  language: string | null;
  framework: string | null;
  organization_id: string;
  role: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectListItem extends ProjectRow {
  runs: number;
  last_run_id: string | null;
  last_run_status: string | null;
  last_run_at: string | null;
  last_severity_counts: Record<string, number> | null;
  open_findings: number;
}

export async function listProjects(organizationId: string): Promise<ProjectListItem[]> {
  const rows = await query<ProjectRow & {
    runs: string;
    last_run_id: string | null;
    last_run_status: string | null;
    last_run_at: string | null;
    last_summary: unknown;
    open_findings: string;
  }>(
    `select p.*,
            (select count(*)::text from audit_runs r where r.project_id = p.id) as runs,
            last_run.id as last_run_id,
            last_run.status as last_run_status,
            last_run.created_at as last_run_at,
            last_run.summary as last_summary,
            (select count(*)::text from findings f
               join audit_runs r2 on r2.id = f.audit_run_id
              where f.project_id = p.id and f.status in ('open','confirmed')
                and r2.id = last_run.id) as open_findings
       from projects p
       left join lateral (
         select r.id, r.status, r.created_at, r.summary
           from audit_runs r
          where r.project_id = p.id
          order by r.created_at desc
          limit 1
       ) last_run on true
      where p.organization_id = $1 and p.deleted_at is null
      order by p.updated_at desc`,
    [organizationId],
  );

  return rows.map((row) => {
    const summary = row.last_summary as AuditSummary | null;
    return {
      ...row,
      runs: Number(row.runs),
      open_findings: Number(row.open_findings),
      last_severity_counts: summary?.severityCounts ?? null,
    };
  });
}

export async function getProject(projectId: string): Promise<ProjectRow | null> {
  const rows = await query<ProjectRow>(`select * from projects where id = $1 and deleted_at is null limit 1`, [
    projectId,
  ]);
  return rows[0] ?? null;
}

export interface AuditJobRow {
  id: string;
  project_id: string;
  triggered_by: string | null;
  commit_sha: string | null;
  branch: string | null;
  ref: string | null;
  status: string;
  progress: number;
  stages: unknown;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  created_at: string;
}

export interface AuditRunRow {
  id: string;
  audit_job_id: string;
  project_id: string;
  engine_version: string;
  rule_version: string;
  ai_model: string | null;
  status: string;
  stack: StackInfo | null;
  stats: { quality?: QualityMetrics; architecture?: ArchitectureSummary; totals?: Record<string, number> } | null;
  summary: AuditSummary | null;
  limitations: { ar: string; en: string }[] | null;
  engines: EngineRunInfo[] | null;
  source: RepoSnapshot["source"] | null;
  commit_sha: string | null;
  branch: string | null;
  duration_ms: number | null;
  created_at: string;
}

export async function listProjectRuns(projectId: string, limit = 30): Promise<AuditRunRow[]> {
  return query<AuditRunRow>(
    `select * from audit_runs where project_id = $1 order by created_at desc limit $2`,
    [projectId, limit],
  );
}

export async function getRun(runId: string): Promise<AuditRunRow | null> {
  const rows = await query<AuditRunRow>(`select * from audit_runs where id = $1 limit 1`, [runId]);
  return rows[0] ?? null;
}

export async function getJob(jobId: string): Promise<AuditJobRow | null> {
  const rows = await query<AuditJobRow>(`select * from audit_jobs where id = $1 limit 1`, [jobId]);
  return rows[0] ?? null;
}

export async function getRunByJob(jobId: string): Promise<AuditRunRow | null> {
  const rows = await query<AuditRunRow>(
    `select * from audit_runs where audit_job_id = $1 order by created_at desc limit 1`,
    [jobId],
  );
  return rows[0] ?? null;
}

export async function getLatestRun(projectId: string): Promise<AuditRunRow | null> {
  const rows = await query<AuditRunRow>(
    `select * from audit_runs where project_id = $1 order by created_at desc limit 1`,
    [projectId],
  );
  return rows[0] ?? null;
}

export async function getPreviousRun(projectId: string, runId: string): Promise<AuditRunRow | null> {
  const rows = await query<AuditRunRow>(
    `select * from audit_runs
      where project_id = $1 and created_at < (select created_at from audit_runs where id = $2)
      order by created_at desc limit 1`,
    [projectId, runId],
  );
  return rows[0] ?? null;
}

/* ------------------------------ findings ----------------------------- */

interface FindingRow {
  id: string;
  audit_run_id: string;
  project_id: string;
  rule_id: string;
  rule_version: string;
  engine: string;
  category: string;
  severity: Severity;
  severity_source: string;
  severity_reason: string | null;
  confidence: number;
  detection_confidence: number | null;
  ai_confidence: number | null;
  title: BilingualText;
  description: BilingualText;
  impact: BilingualText;
  recommendation: BilingualText;
  status: string;
  status_reason: string | null;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  symbol: string | null;
  evidence: Finding["evidence"] | null;
  detection_method: BilingualText;
  tool_reference: string | null;
  fingerprint: string;
  metadata: Record<string, unknown> | null;
}

export interface FindingFilters {
  severity?: Severity | "all";
  category?: string | "all";
  status?: string | "all";
  search?: string;
  file?: string;
  limit?: number;
}

export async function listFindings(runId: string, filters: FindingFilters = {}): Promise<FindingRow[]> {
  const conditions: string[] = ["audit_run_id = $1"];
  const params: unknown[] = [runId];
  if (filters.severity && filters.severity !== "all") {
    params.push(filters.severity);
    conditions.push(`severity = $${params.length}`);
  }
  if (filters.category && filters.category !== "all") {
    params.push(filters.category);
    conditions.push(`category = $${params.length}`);
  }
  if (filters.status && filters.status !== "all") {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filters.file) {
    params.push(`%${filters.file}%`);
    conditions.push(`file_path ilike $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const idx = params.length;
    conditions.push(`(title->>'en' ilike $${idx} or title->>'ar' ilike $${idx} or file_path ilike $${idx} or rule_id ilike $${idx})`);
  }
  params.push(filters.limit ?? 500);
  return query<FindingRow>(
    `select * from findings where ${conditions.join(" and ")}
      order by case severity when 'CRITICAL' then 0 when 'HIGH' then 1 when 'MEDIUM' then 2 when 'LOW' then 3 else 4 end,
               file_path nulls last, line_start nulls last
      limit $${params.length}`,
    params,
  );
}

export async function countFindingsBySeverity(runId: string): Promise<Record<string, number>> {
  const rows = await query<{ severity: string; total: string }>(
    `select severity, count(*)::text as total from findings where audit_run_id = $1 group by severity`,
    [runId],
  );
  const counts: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const row of rows) counts[row.severity] = Number(row.total);
  return counts;
}

export interface FindingDetail extends FindingRow {
  project_name: string;
  run_created_at: string;
  run_commit: string | null;
  run_job_id: string;
  evidence_rows: { id: string; source_type: string; source_reference: string; snippet: string | null; metadata: Record<string, unknown> | null }[];
  events: { id: string; action: string; reason: string | null; created_at: string }[];
  ai: (AiExplanation & { id: string; model: string | null; prompt_version: string; created_at: string }) | null;
  occurrences: number;
}

export async function getFindingDetail(findingId: string): Promise<FindingDetail | null> {
  const rows = await query<
    FindingRow & {
      project_name: string;
      run_created_at: string;
      run_commit: string | null;
      run_job_id: string;
    }
  >(
    `select f.*, p.name as project_name, r.created_at as run_created_at, r.commit_sha as run_commit,
            r.audit_job_id as run_job_id
       from findings f
       join projects p on p.id = f.project_id
       join audit_runs r on r.id = f.audit_run_id
      where f.id = $1 limit 1`,
    [findingId],
  );
  const finding = rows[0];
  if (!finding) return null;

  const [evidenceRows, events, aiRows, occurrences] = await Promise.all([
    query<FindingDetail["evidence_rows"][number]>(
      `select id, source_type, source_reference, snippet, metadata from finding_evidence where finding_id = $1 order by created_at asc`,
      [findingId],
    ),
    query<FindingDetail["events"][number]>(
      `select id, action, reason, created_at from finding_events where finding_id = $1 order by created_at desc limit 20`,
      [findingId],
    ),
    query<{ id: string; result: AiExplanation; model: string | null; prompt_version: string; created_at: string }>(
      `select id, result, model, prompt_version, created_at from ai_reviews
        where finding_id = $1 and kind = 'finding_explanation' order by created_at desc limit 1`,
      [findingId],
    ),
    query<{ total: string }>(
      `select count(*)::text as total from findings where fingerprint = $1`,
      [finding.fingerprint],
    ),
  ]);

  const aiRow = aiRows[0];
  return {
    ...finding,
    evidence_rows: evidenceRows,
    events,
    ai: aiRow
      ? { ...aiRow.result, id: aiRow.id, model: aiRow.model, prompt_version: aiRow.prompt_version, created_at: aiRow.created_at }
      : null,
    occurrences: Number(occurrences[0]?.total ?? "1"),
  };
}

export async function updateFindingStatus(
  findingId: string,
  status: FindingStatus,
  reason: string | null,
  userId: string | null,
): Promise<void> {
  await query(
    `update findings set status = $2, status_reason = $3, status_updated_at = now(), status_updated_by = $4 where id = $1`,
    [findingId, status, reason, userId],
  );
  await query(
    `insert into finding_events (id, finding_id, user_id, action, reason) values ($1, $2, $3, $4, $5)`,
    [`fev_${Math.random().toString(36).slice(2, 14)}`, findingId, userId, `status:${status}`, reason],
  );
}

export async function recordDecision(
  projectId: string,
  fingerprint: string,
  decision: string,
  reason: string | null,
  userId: string | null,
): Promise<void> {
  await query(
    `insert into finding_decisions (id, project_id, fingerprint, user_id, decision, reason)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (project_id, fingerprint) do update set decision = excluded.decision, reason = excluded.reason, created_at = now()`,
    [`dec_${Math.random().toString(36).slice(2, 14)}`, projectId, fingerprint, userId, decision, reason],
  );
}

export async function getDecisionsForFingerprints(
  projectId: string,
  fingerprints: string[],
): Promise<Record<string, string>> {
  if (fingerprints.length === 0) return {};
  const rows = await query<{ fingerprint: string; decision: string }>(
    `select fingerprint, decision from finding_decisions where project_id = $1 and fingerprint = any($2)`,
    [projectId, fingerprints],
  );
  return Object.fromEntries(rows.map((row) => [row.fingerprint, row.decision]));
}

/* --------------------------- dependencies ---------------------------- */

export async function listDependencies(runId: string, onlyVulnerable = false): Promise<(DependencyRecord & { id: string; vulnerabilities: VulnerabilityRecord[] })[]> {
  const rows = await query<{
    id: string;
    package_manager: string;
    package_name: string;
    version: string;
    ecosystem: string;
    scope: string;
    manifest_path: string | null;
    vulnerability_count: number;
    latest_version: string | null;
    outdated: boolean | null;
    vulnerabilities: VulnerabilityRecord[] | null;
  }>(
    `select d.*,
            (select json_agg(json_build_object(
                'advisoryId', v.advisory_id, 'severity', v.severity, 'cvss', v.cvss,
                'summary', v.summary, 'description', v.description, 'fixedVersion', v.fixed_version,
                'source', v.source, 'publishedAt', v.published_at, 'references', v.advisory_references))
               from vulnerabilities v where v.dependency_id = d.id) as vulnerabilities
       from dependencies d
      where d.audit_run_id = $1 ${onlyVulnerable ? "and d.vulnerability_count > 0" : ""}
      order by d.vulnerability_count desc, d.package_name asc
      limit 400`,
    [runId],
  );
  return rows.map((row) => ({
    id: row.id,
    packageManager: row.package_manager,
    packageName: row.package_name,
    version: row.version,
    ecosystem: row.ecosystem,
    scope: row.scope === "transitive" ? "transitive" : "direct",
    manifestPath: row.manifest_path ?? "",
    latestVersion: row.latest_version,
    outdated: row.outdated,
    vulnerabilities: row.vulnerabilities ?? [],
  }));
}

export async function listTestRuns(runId: string): Promise<TestRunRecord[]> {
  const rows = await query<{
    framework: string | null;
    command: string | null;
    status: string;
    executed: boolean;
    passed: number | null;
    failed: number | null;
    skipped: number | null;
    coverage: number | null;
    duration_ms: number | null;
    output_excerpt: string | null;
    source_reference: string | null;
  }>(`select * from test_runs where audit_run_id = $1 order by status desc`, [runId]);
  return rows.map((row) => ({
    framework: row.framework ?? "unknown",
    command: row.command,
    status: (row.status as TestRunRecord["status"]) ?? "detected",
    executed: row.executed,
    passed: row.passed,
    failed: row.failed,
    skipped: row.skipped,
    coveragePercent: row.coverage,
    durationMs: row.duration_ms,
    outputExcerpt: row.output_excerpt,
    sourceReference: row.source_reference,
  }));
}

/* ---------------------------- dashboard ------------------------------ */

export async function recentFindings(organizationId: string, limit = 8) {
  return query<{
    id: string;
    title: BilingualText;
    severity: Severity;
    category: string;
    file_path: string | null;
    line_start: number | null;
    created_at: string;
    project_id: string;
    project_name: string;
    run_id: string;
  }>(
    `select f.id, f.title, f.severity, f.category, f.file_path, f.line_start, f.created_at,
            p.id as project_id, p.name as project_name, f.audit_run_id as run_id
       from findings f
       join projects p on p.id = f.project_id
       join audit_runs r on r.id = f.audit_run_id
      where p.organization_id = $1 and f.status in ('open','confirmed')
      order by case f.severity when 'CRITICAL' then 0 when 'HIGH' then 1 when 'MEDIUM' then 2 else 3 end,
               f.created_at desc
      limit $2`,
    [organizationId, limit],
  );
}

export async function recentRuns(organizationId: string, limit = 8) {
  return query<{
    id: string;
    status: string;
    created_at: string;
    project_id: string;
    project_name: string;
    severity_counts: Record<string, number> | null;
    total_findings: string;
  }>(
    `select r.id, r.status, r.created_at, p.id as project_id, p.name as project_name,
            r.summary -> 'severityCounts' as severity_counts,
            (select count(*)::text from findings f where f.audit_run_id = r.id) as total_findings
       from audit_runs r
       join projects p on p.id = r.project_id
      where p.organization_id = $1 and p.deleted_at is null
      order by r.created_at desc
      limit $2`,
    [organizationId, limit],
  );
}

export async function projectTrend(projectId: string, limit = 10) {
  const rows = await query<{ id: string; created_at: string; severity_counts: Record<string, number> | null }>(
    `select id, created_at, summary -> 'severityCounts' as severity_counts
       from audit_runs where project_id = $1 order by created_at desc limit $2`,
    [projectId, limit],
  );
  return rows.reverse();
}

export async function dashboardTotals(organizationId: string) {
  const rows = await query<{ projects: string; runs: string; open_findings: string }>(
    `select
       (select count(*)::text from projects p where p.organization_id = $1 and p.deleted_at is null) as projects,
       (select count(*)::text from audit_runs r join projects p on p.id = r.project_id where p.organization_id = $1) as runs,
       (select count(*)::text from findings f join projects p on p.id = f.project_id
         where p.organization_id = $1 and f.status in ('open','confirmed')) as open_findings`,
    [organizationId],
  );
  const row = rows[0];
  return {
    projects: Number(row?.projects ?? "0"),
    runs: Number(row?.runs ?? "0"),
    openFindings: Number(row?.open_findings ?? "0"),
  };
}

export async function deleteProjectData(projectId: string): Promise<void> {
  // Deleting the project cascades to audits, findings, evidence, dependencies, AI reviews
  // and reports — the privacy page promises exactly that.
  await query(`delete from projects where id = $1`, [projectId]);
}

export async function deleteAllUserData(organizationId: string): Promise<void> {
  await query(`delete from projects where organization_id = $1`, [organizationId]);
}

export async function compareJobs(baseJobId: string, headJobId: string): Promise<ComparisonResult | null> {
  const [base, head] = await Promise.all([getRunByJob(baseJobId), getRunByJob(headJobId)]);
  if (!base || !head) return null;
  return compareRuns(base.id, head.id);
}

/* ---------------------------- comparison ----------------------------- */

export interface ComparisonResult {
  base: { id: string; createdAt: string; counts: Record<string, number> };
  head: { id: string; createdAt: string; counts: Record<string, number> };
  resolved: ComparisonItem[];
  created: ComparisonItem[];
  unchanged: ComparisonItem[];
  reopened: ComparisonItem[];
}

export interface ComparisonItem {
  fingerprint: string;
  ruleId: string;
  title: BilingualText;
  severity: Severity;
  filePath: string | null;
  lineStart: number | null;
  findingId: string;
  status: string;
}

export async function compareRuns(baseRunId: string, headRunId: string): Promise<ComparisonResult | null> {
  const [baseRun, headRun] = await Promise.all([getRun(baseRunId), getRun(headRunId)]);
  if (!baseRun || !headRun) return null;

  const rows = await query<{
    fingerprint: string;
    rule_id: string;
    title: BilingualText;
    severity: Severity;
    file_path: string | null;
    line_start: number | null;
    status: string;
    audit_run_id: string;
    id: string;
  }>(
    `select id, fingerprint, rule_id, title, severity, file_path, line_start, status, audit_run_id
       from findings where audit_run_id in ($1, $2)`,
    [baseRunId, headRunId],
  );

  const base = new Map<string, (typeof rows)[number]>();
  const head = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.audit_run_id === baseRunId) base.set(row.fingerprint, row);
    else head.set(row.fingerprint, row);
  }

  const toItem = (row: (typeof rows)[number]): ComparisonItem => ({
    fingerprint: row.fingerprint,
    ruleId: row.rule_id,
    title: row.title,
    severity: row.severity,
    filePath: row.file_path,
    lineStart: row.line_start,
    findingId: row.id,
    status: row.status,
  });

  const resolved: ComparisonItem[] = [];
  const created: ComparisonItem[] = [];
  const unchanged: ComparisonItem[] = [];
  const reopened: ComparisonItem[] = [];

  for (const [fingerprint, row] of base) {
    if (head.has(fingerprint)) {
      unchanged.push(toItem(head.get(fingerprint)!));
    } else {
      resolved.push(toItem(row));
    }
  }
  for (const [fingerprint, row] of head) {
    if (!base.has(fingerprint)) {
      if (["fixed"].includes(row.status)) continue;
      created.push(toItem(row));
    } else if (row.status === "open" && ["fixed"].includes(base.get(fingerprint)!.status)) {
      reopened.push(toItem(row));
    }
  }

  const severityOrder: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
  const sortItems = (items: ComparisonItem[]) =>
    items.sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity));

  return {
    base: { id: baseRun.id, createdAt: baseRun.created_at, counts: baseRun.summary?.severityCounts ?? {} },
    head: { id: headRun.id, createdAt: headRun.created_at, counts: headRun.summary?.severityCounts ?? {} },
    resolved: sortItems(resolved),
    created: sortItems(created),
    unchanged: sortItems(unchanged),
    reopened: sortItems(reopened),
  };
}
