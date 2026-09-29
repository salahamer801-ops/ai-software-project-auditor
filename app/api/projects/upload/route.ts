import { isSameOrigin, logAuditEvent } from "@/lib/auth";
import { getSessionUserSafe } from "@/lib/session";
import { detectArchive } from "@/lib/sources/extract";
import { createProjectWithJob } from "@/lib/projects";

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "bad_origin" }, { status: 403 });
  const user = await getSessionUserSafe();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (user.role === "viewer") return Response.json({ error: "forbidden" }, { status: 403 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "invalid_archive" }, { status: 400 });
  }

  const file = form.get("archive");
  const name = String(form.get("name") ?? "").trim();
  const ref = String(form.get("ref") ?? "").trim() || "upload";
  if (!(file instanceof File)) return Response.json({ error: "invalid_archive" }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return Response.json({ error: "too_large" }, { status: 413 });

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!detectArchive(buffer, file.name)) {
    return Response.json({ error: "invalid_archive" }, { status: 400 });
  }

  const { projectId, jobId } = await createProjectWithJob({
    organizationId: user.organizationId,
    userId: user.id,
    name: name || file.name.replace(/\.(zip|tar\.gz|tgz|tar)$/i, "") || "Uploaded project",
    sourceType: "upload",
    ref,
    archiveName: file.name,
    archiveBytes: buffer,
    visibility: "upload",
  });

  await logAuditEvent({
    organizationId: user.organizationId,
    userId: user.id,
    projectId,
    action: "project.created",
    metadata: { source: "upload", filename: file.name, bytes: buffer.length },
  });

  return Response.json({ ok: true, projectId, jobId });
}
