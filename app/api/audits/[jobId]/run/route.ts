import { executeAudit, type ProgressEvent } from "@/lib/analysis/runner";
import { getSessionUserSafe } from "@/lib/session";
import { getJob, getRunByJob, getProject } from "@/lib/queries";
import { query } from "@/lib/db";
import { getProjectAccess } from "@/lib/auth";
import { httpError, withRoute } from "@/lib/api/route";
import { log } from "@/lib/observability/log";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Runs one audit and streams its stages back as newline-delimited JSON.
 *
 * The stream is what keeps the audit observable without a background worker: each engine
 * transition is persisted on the job row *and* pushed to the browser immediately, so a
 * reload or a sleeping container never loses the audit state.
 *
 * No timeout is imposed here on purpose: an audit may legitimately take minutes, so this
 * route only wraps the existing pipeline with a request id and start/finish log lines.
 */
export const POST = withRoute<{ jobId: string }>("audit.run", async (_request, { params }, meta) => {
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

  // Already finished: return the outcome instead of running it twice.
  if (job.status === "COMPLETED") {
    const run = await getRunByJob(jobId);
    return Response.json({
      ok: true,
      alreadyCompleted: true,
      runId: run?.id ?? null,
      findings: run?.summary?.totalFindings ?? 0,
    });
  }

  const startedAt = Date.now();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        } catch {
          /* client disconnected */
        }
      };
      try {
        const outcome = await executeAudit(jobId, (event: ProgressEvent) =>
          send({ type: "progress", ...event }),
        );
        send({ type: "done", ...outcome });
        log("info", "audit.run.finished", {
          requestId: meta.requestId,
          jobId,
          status: outcome.status,
          findings: outcome.findings,
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        send({ type: "error", error: error instanceof Error ? error.message : "audit_failed" });
        log("error", "audit.run.failed", {
          requestId: meta.requestId,
          jobId,
          durationMs: Date.now() - startedAt,
          error,
        });
      } finally {
        try {
          await query(`update audit_jobs set stages = coalesce(stages, '[]'::jsonb) where id = $1`, [jobId]);
        } catch {
          /* ignore */
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
});
