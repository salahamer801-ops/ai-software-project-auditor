import { buildReport } from "@/lib/report";
import { getSessionUserSafe } from "@/lib/session";
import { getProjectAccess } from "@/lib/auth";
import { getJob, getProject } from "@/lib/queries";
import { httpError, withRoute } from "@/lib/api/route";
import { withSpan } from "@/lib/observability/log";

export const dynamic = "force-dynamic";

export const GET = withRoute<{ jobId: string }>("audit.report", async (_request, { params }, meta) => {
  const user = await getSessionUserSafe();
  if (!user) throw httpError(401, "unauthorized");
  const { jobId } = await params;
  const job = await getJob(jobId);
  if (!job) throw httpError(404, "not_found");
  const project = await getProject(job.project_id);
  if (!project) throw httpError(404, "not_found");
  const access = await getProjectAccess(project.id, user.id);
  if (!access) throw httpError(403, "forbidden");

  const report = await withSpan("audit.report.build", { requestId: meta.requestId, jobId }, () => buildReport(jobId));
  if (!report) throw httpError(409, "report_not_ready");

  return new Response(JSON.stringify(report, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="audit-${jobId}.json"`,
      "cache-control": "no-store",
    },
  });
});
