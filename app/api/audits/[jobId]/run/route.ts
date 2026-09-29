import { executeAudit, type ProgressEvent } from "@/lib/analysis/runner";
import { getSessionUserSafe } from "@/lib/session";
import { getJob, getRunByJob, getProject } from "@/lib/queries";
import { query } from "@/lib/db";
import { getProjectAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Runs one audit and streams its stages back as newline-delimited JSON.
 *
 * The stream is what keeps the audit observable without a background worker: each engine
 * transition is persisted on the job row *and* pushed to the browser immediately, so a
 * reload or a sleeping container never loses the audit state.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const user = await getSessionUserSafe();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { jobId } = await params;

  const job = await getJob(jobId);
  if (!job) return Response.json({ error: "job_not_found" }, { status: 404 });
  const project = await getProject(job.project_id);
  if (!project) return Response.json({ error: "project_not_found" }, { status: 404 });
  const access = await getProjectAccess(project.id, user.id);
  if (!access || !["owner", "admin", "developer"].includes(access.role)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
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
      } catch (error) {
        send({ type: "error", error: error instanceof Error ? error.message : "audit_failed" });
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
}
