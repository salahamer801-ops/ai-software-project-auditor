import { runSelfTests } from "@/lib/selftest";
import { getSessionUserSafe } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST() {
  const user = await getSessionUserSafe();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  const results = runSelfTests();
  return Response.json({
    ok: results.every((result) => result.passed),
    durationMs: Date.now() - started,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    results,
  });
}
