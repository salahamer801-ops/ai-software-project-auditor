import { getSessionUserSafe } from "@/lib/session";
import { isSameOrigin, logAuditEvent, requireProjectAccess } from "@/lib/auth";
import { queueAudit } from "@/lib/projects";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "bad_origin" }, { status: 403 });
  const user = await getSessionUserSafe();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await requireProjectAccess(id, user.id, "developer");
  if (!access) return Response.json({ error: "forbidden" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { ref?: string };
  const ref = (body.ref ?? "").trim() || access.defaultBranch || (access.sourceType === "demo" ? "demo" : null);
  const jobId = await queueAudit(id, user.id, ref);
  await logAuditEvent({
    organizationId: user.organizationId,
    userId: user.id,
    projectId: id,
    action: "audit.queued",
    metadata: { jobId, ref, manual: true },
  });
  return Response.json({ ok: true, jobId });
}
