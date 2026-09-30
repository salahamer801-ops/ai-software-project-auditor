import { getSessionUserSafe } from "@/lib/session";
import { getProjectAccess, isSameOrigin, logAuditEvent } from "@/lib/auth";
import { getJob, getProject } from "@/lib/queries";
import { query } from "@/lib/db";
import { httpError, withRoute } from "@/lib/api/route";

export const POST = withRoute<{ jobId: string }>("audit.cancel", async (request, { params }) => {
  if (!isSameOrigin(request)) throw httpError(403, "bad_origin");
  const user = await getSessionUserSafe();
  if (!user) throw httpError(401, "unauthorized");
  const { jobId } = await params;

  const job = await getJob(jobId);
  if (!job) throw httpError(404, "job_not_found");
  const project = await getProject(job.project_id);
  if (!project) throw httpError(404, "project_not_found");
  const access = await getProjectAccess(project.id, user.id);
  if (!access || !["owner", "admin", "developer"].includes(access.role)) {
    throw httpError(403, "forbidden");
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
});
