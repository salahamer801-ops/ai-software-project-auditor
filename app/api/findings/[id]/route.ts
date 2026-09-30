import { getSessionUserSafe } from "@/lib/session";
import { isSameOrigin, logAuditEvent } from "@/lib/auth";
import { getFindingDetail, recordDecision, updateFindingStatus, type FindingDetail } from "@/lib/queries";
import { getProjectAccess } from "@/lib/auth";
import type { FindingStatus } from "@/lib/types";
import { httpError, oneOf, readJson, str, withRoute } from "@/lib/api/route";

const ALLOWED: FindingStatus[] = ["open", "confirmed", "false_positive", "ignored", "fixed"];

interface StatusBody {
  status?: string;
  reason?: string;
}

export const PATCH = withRoute<{ id: string }>("finding.update", async (request, { params }) => {
  if (!isSameOrigin(request)) throw httpError(403, "bad_origin");
  const user = await getSessionUserSafe();
  if (!user) throw httpError(401, "unauthorized");
  const { id } = await params;

  const finding = (await getFindingDetail(id)) as FindingDetail | null;
  if (!finding) throw httpError(404, "not_found");
  const access = await getProjectAccess(finding.project_id, user.id);
  if (!access || !["owner", "admin", "developer"].includes(access.role)) {
    throw httpError(403, "forbidden");
  }

  const body = await readJson<StatusBody>(request);
  const status = oneOf(body.status, ALLOWED, "status", { code: "invalid_status" });
  const reason = str(body.reason, { field: "reason", optional: true, trim: true, max: 400, clamp: true }) || null;

  await updateFindingStatus(id, status, reason, user.id);
  // The decision is stored per fingerprint so the same issue keeps its status in the
  // next audit without ever deleting anything from history (§47).
  if (["false_positive", "ignored", "fixed", "confirmed"].includes(status)) {
    await recordDecision(finding.project_id, finding.fingerprint, status, reason, user.id);
  }
  await logAuditEvent({
    organizationId: access.organizationId,
    userId: user.id,
    projectId: finding.project_id,
    action: `finding.${status}`,
    metadata: { findingId: id, ruleId: finding.rule_id, reason },
  });

  return Response.json({ ok: true, status, reason });
});
