import { getSessionUserSafe } from "@/lib/session";
import { isSameOrigin, logAuditEvent, requireProjectAccess } from "@/lib/auth";
import { deleteProjectData } from "@/lib/queries";
import { httpError, withRoute } from "@/lib/api/route";

export const DELETE = withRoute<{ id: string }>("project.delete", async (request, { params }) => {
  if (!isSameOrigin(request)) throw httpError(403, "bad_origin");
  const user = await getSessionUserSafe();
  if (!user) throw httpError(401, "unauthorized");
  const { id } = await params;
  const access = await requireProjectAccess(id, user.id, "admin");
  if (!access) throw httpError(403, "forbidden");

  await deleteProjectData(id);
  await logAuditEvent({
    organizationId: user.organizationId,
    userId: user.id,
    projectId: null,
    action: "project.deleted",
    metadata: { projectId: id, name: access.name },
  });
  return Response.json({ ok: true });
});
