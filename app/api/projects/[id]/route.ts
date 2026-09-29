import { getSessionUserSafe } from "@/lib/session";
import { isSameOrigin, logAuditEvent, requireProjectAccess } from "@/lib/auth";
import { deleteProjectData } from "@/lib/queries";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "bad_origin" }, { status: 403 });
  const user = await getSessionUserSafe();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await requireProjectAccess(id, user.id, "admin");
  if (!access) return Response.json({ error: "forbidden" }, { status: 403 });

  await deleteProjectData(id);
  await logAuditEvent({
    organizationId: user.organizationId,
    userId: user.id,
    projectId: null,
    action: "project.deleted",
    metadata: { projectId: id, name: access.name },
  });
  return Response.json({ ok: true });
}
