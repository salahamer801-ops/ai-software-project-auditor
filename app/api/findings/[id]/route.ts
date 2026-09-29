import { getSessionUserSafe } from "@/lib/session";
import { isSameOrigin, logAuditEvent } from "@/lib/auth";
import { getFindingDetail, recordDecision, updateFindingStatus, type FindingDetail } from "@/lib/queries";
import { getProjectAccess } from "@/lib/auth";
import type { FindingStatus } from "@/lib/types";

const ALLOWED: FindingStatus[] = ["open", "confirmed", "false_positive", "ignored", "fixed"];

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "bad_origin" }, { status: 403 });
  const user = await getSessionUserSafe();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const finding = (await getFindingDetail(id)) as FindingDetail | null;
  if (!finding) return Response.json({ error: "not_found" }, { status: 404 });
  const access = await getProjectAccess(finding.project_id, user.id);
  if (!access || !["owner", "admin", "developer"].includes(access.role)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { status?: string; reason?: string };
  const status = body.status as FindingStatus;
  if (!ALLOWED.includes(status)) return Response.json({ error: "invalid_status" }, { status: 400 });
  const reason = (body.reason ?? "").trim().slice(0, 400) || null;

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
}
