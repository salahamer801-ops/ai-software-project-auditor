import { buildReport } from "@/lib/report";
import { getSessionUserSafe } from "@/lib/session";
import { getProjectAccess } from "@/lib/auth";
import { getJob, getProject } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const user = await getSessionUserSafe();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { jobId } = await params;
  const job = await getJob(jobId);
  if (!job) return Response.json({ error: "not_found" }, { status: 404 });
  const project = await getProject(job.project_id);
  if (!project) return Response.json({ error: "not_found" }, { status: 404 });
  const access = await getProjectAccess(project.id, user.id);
  if (!access) return Response.json({ error: "forbidden" }, { status: 403 });

  const report = await buildReport(jobId);
  if (!report) return Response.json({ error: "report_not_ready" }, { status: 409 });

  return new Response(JSON.stringify(report, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="audit-${jobId}.json"`,
      "cache-control": "no-store",
    },
  });
}
