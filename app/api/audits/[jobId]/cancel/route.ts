import { getSessionUserSafe } from "@/lib/session";
import { getProjectAccess, isSameOrigin, logAuditEvent } from "@/lib/auth";
import { getJob, getProject } from "@/lib/queries";
import { query } from "@/lib/db";

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "bad_origin" }, { status: 403 });
  const user = await getSessionUserSafe();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { jobId } = await params;

  const job = await getJob(jobId);
  if (!job) return Response.json({ error: "job_not_found" }, { status: 404 });
  const project = await getProject(job.project_id);
  if (!project) return Response.json({ error: "project_not_found" }, { status: 404 });
  const access = await getProjectAccess(project.id, user.id);
  if (!access || !["owner", "admin", "developer"].includes(access.role)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(job.status)) {
    return Response.json({ ok: true, status: job.status });
  }

  await query(`update audit_jobs set status = 'CANCELLED', completed_at = now() where id = $1`, [jobId]);
  await logAuditEvent({
    organizationId: user.organizationId,
    userId: user.id,
    projectId: project.id,
    action: "audit.cancelled",
    metadata: { jobId },
  });
  return Response.json({ ok: true, status: "CANCELLED" });
}
