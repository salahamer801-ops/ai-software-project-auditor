import { isSameOrigin, logAuditEvent } from "@/lib/auth";
import { getSessionUserSafe } from "@/lib/session";
import { detectArchive } from "@/lib/sources/extract";
import { createProjectWithJob } from "@/lib/projects";
import { httpError, str, withRoute } from "@/lib/api/route";
import { log, withSpan } from "@/lib/observability/log";

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
/** Multipart framing adds a little overhead on top of the file itself. */
const MULTIPART_SLACK_BYTES = 1024 * 1024;

export const POST = withRoute("projects.upload", async (request, _ctx, meta) => {
  if (!isSameOrigin(request)) throw httpError(403, "bad_origin");
  const user = await getSessionUserSafe();
  if (!user) throw httpError(401, "unauthorized");
  if (user.role === "viewer") throw httpError(403, "forbidden");

  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES + MULTIPART_SLACK_BYTES) {
    throw httpError(413, "too_large");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw httpError(400, "invalid_archive");
  }

  const file = form.get("archive");
  const name = str(form.get("name"), { field: "name", optional: true, trim: true, max: 200, clamp: true }) ?? "";
  const ref = str(form.get("ref"), { field: "ref", optional: true, trim: true, max: 200, clamp: true }) || "upload";
  if (!(file instanceof File)) throw httpError(400, "invalid_archive");
  if (file.size > MAX_UPLOAD_BYTES) throw httpError(413, "too_large");

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!detectArchive(buffer, file.name)) {
    throw httpError(400, "invalid_archive");
  }

  const { projectId, jobId } = await withSpan(
    "projects.upload.store",
    { requestId: meta.requestId, filename: file.name, bytes: buffer.length, ref },
    () =>
      createProjectWithJob({
        organizationId: user.organizationId,
        userId: user.id,
        name: name || file.name.replace(/\.(zip|tar\.gz|tgz|tar)$/i, "") || "Uploaded project",
        sourceType: "upload",
        ref,
        archiveName: file.name,
        archiveBytes: buffer,
        visibility: "upload",
      }),
  );

  log("info", "project.created", { requestId: meta.requestId, projectId, jobId, source: "upload" });

  await logAuditEvent({
    organizationId: user.organizationId,
    userId: user.id,
    projectId,
    action: "project.created",
    metadata: { source: "upload", filename: file.name, bytes: buffer.length },
  });

  return Response.json({ ok: true, projectId, jobId });
});
