import { getSessionUserSafe } from "@/lib/session";
import { isSameOrigin, logAuditEvent, requireProjectAccess } from "@/lib/auth";
import { queueAudit } from "@/lib/projects";
import { bool, httpError, readJson, str, withRoute } from "@/lib/api/route";

interface QueueBody {
  ref?: string;
  /** Opt-in: run the project's self-contained Node test files in the execution sandbox (§24). */
  runTests?: boolean;
}

export const POST = withRoute<{ id: string }>("project.audits.queue", async (request, { params }) => {
  if (!isSameOrigin(request)) throw httpError(403, "bad_origin");
  const user = await getSessionUserSafe();
  if (!user) throw httpError(401, "unauthorized");
  const { id } = await params;
  const access = await requireProjectAccess(id, user.id, "developer");
  if (!access) throw httpError(403, "forbidden");

  // The button that queues a manual audit posts no body at all, so an absent body is
  // an empty object and `ref` falls back to the project's branch.
  const body = await readJson<QueueBody>(request);
  const requestedRef = str(body.ref, { field: "ref", optional: true, trim: true, max: 200, clamp: true }) ?? "";
  const ref = requestedRef || access.defaultBranch || (access.sourceType === "demo" ? "demo" : null);
  const runTests = bool(body.runTests, { field: "runTests", optional: true }) ?? false;
  const jobId = await queueAudit(id, user.id, ref, { runTests });
  await logAuditEvent({
    organizationId: user.organizationId,
    userId: user.id,
    projectId: id,
    action: "audit.queued",
    metadata: { jobId, ref, manual: true, runTests },
  });
  return Response.json({ ok: true, jobId });
});
