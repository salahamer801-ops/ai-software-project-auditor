import { runSelfTests } from "@/lib/selftest";
import { getSessionUserSafe } from "@/lib/session";
import { httpError, withRoute } from "@/lib/api/route";
import { log } from "@/lib/observability/log";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const POST = withRoute("selftest.run", async (_request, _ctx, meta) => {
  const user = await getSessionUserSafe();
  if (!user) throw httpError(401, "unauthorized");
  const started = Date.now();
  const results = runSelfTests();
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const durationMs = Date.now() - started;

  log("info", "selftest.finished", { requestId: meta.requestId, passed, failed, durationMs });

  return Response.json({
    ok: failed === 0,
    durationMs,
    passed,
    failed,
    results,
  });
});
