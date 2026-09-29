import { newId, query } from "./db";
import { slugify } from "./auth";
import type { AuditJobRow } from "./queries";

export interface CreateProjectInput {
  organizationId: string;
  userId: string;
  name: string;
  sourceType: "github" | "upload" | "demo";
  repositoryUrl?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  defaultBranch?: string | null;
  visibility?: string | null;
  ref?: string | null;
  archiveName?: string;
  archiveBytes?: Buffer;
}

export async function createProjectWithJob(input: CreateProjectInput): Promise<{ projectId: string; jobId: string }> {
  const projectId = newId("prj");
  let slug = slugify(input.name);
  const existing = await query<{ slug: string }>(
    `select slug from projects where organization_id = $1 and slug = $2`,
    [input.organizationId, slug],
  );
  if (existing.length > 0) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;

  await query(
    `insert into projects (id, organization_id, created_by, name, slug, source_type, provider, repository_url,
        repo_owner, repo_name, default_branch, visibility)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      projectId,
      input.organizationId,
      input.userId,
      input.name.slice(0, 120),
      slug,
      input.sourceType,
      input.sourceType === "github" ? "github" : input.sourceType,
      input.repositoryUrl ?? null,
      input.repoOwner ?? null,
      input.repoName ?? null,
      input.defaultBranch ?? null,
      input.visibility ?? (input.sourceType === "github" ? "public" : "upload"),
    ],
  );

  if (input.sourceType === "github") {
    await query(
      `insert into repositories (id, project_id, provider, owner, repository_name, branch, metadata)
       values ($1,$2,'github',$3,$4,$5,$6::jsonb)`,
      [
        newId("rep"),
        projectId,
        input.repoOwner ?? null,
        input.repoName ?? null,
        input.ref ?? input.defaultBranch ?? null,
        JSON.stringify({ repositoryUrl: input.repositoryUrl ?? null, ref: input.ref ?? null }),
      ],
    );
  }

  if (input.archiveBytes && input.archiveBytes.length > 0) {
    await query(
      `insert into project_sources (id, project_id, kind, filename, bytes, size) values ($1,$2,$3,$4,$5,$6)`,
      [newId("src"), projectId, "upload", input.archiveName ?? "project.zip", input.archiveBytes, input.archiveBytes.length],
    );
  }

  const jobId = await queueAudit(projectId, input.userId, input.ref ?? input.defaultBranch ?? null);
  return { projectId, jobId };
}

export async function queueAudit(
  projectId: string,
  userId: string | null,
  ref: string | null,
): Promise<string> {
  const jobId = newId("job");
  await query(
    `insert into audit_jobs (id, project_id, triggered_by, ref, status, progress, stages)
     values ($1,$2,$3,$4,'QUEUED',0,'[]'::jsonb)`,
    [jobId, projectId, userId, ref],
  );
  await query(
    `insert into audit_events (id, organization_id, user_id, project_id, action, metadata)
     select $1, p.organization_id, $2, p.id, 'audit.queued', $3::jsonb from projects p where p.id = $4`,
    [newId("evt"), userId, JSON.stringify({ jobId, ref }), projectId],
  );
  return jobId;
}

export async function recentJobs(projectId: string, limit = 20): Promise<(AuditJobRow & { run_id: string | null; severity_counts: Record<string, number> | null; total_findings: number | null; duration_ms: number | null })[]> {
  const rows = await query<
    AuditJobRow & {
      run_id: string | null;
      severity_counts: Record<string, number> | null;
      total_findings: string | null;
      duration_ms: number | null;
    }
  >(
    `select j.*, r.id as run_id, r.summary -> 'severityCounts' as severity_counts,
            (select count(*)::text from findings f where f.audit_run_id = r.id) as total_findings,
            r.duration_ms
       from audit_jobs j
       left join audit_runs r on r.audit_job_id = j.id
      where j.project_id = $1
      order by j.created_at desc
      limit $2`,
    [projectId, limit],
  );
  return rows.map((row) => ({
    ...row,
    total_findings: row.total_findings === null ? null : Number(row.total_findings),
  }));
}
