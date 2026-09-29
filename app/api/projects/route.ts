import { isSameOrigin, logAuditEvent } from "@/lib/auth";
import { getSessionUserSafe } from "@/lib/session";
import { parseRepoInput } from "@/lib/sources/github";
import { createProjectWithJob } from "@/lib/projects";

interface Body {
  name?: string;
  sourceType?: "github" | "demo";
  repositoryUrl?: string;
  ref?: string;
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "bad_origin" }, { status: 403 });
  const user = await getSessionUserSafe();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (user.role === "viewer") return Response.json({ error: "forbidden" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as Body;
  const sourceType = body.sourceType === "demo" ? "demo" : "github";
  const name = (body.name ?? "").trim();
  const ref = (body.ref ?? "").trim() || null;

  if (sourceType === "demo") {
    const { projectId, jobId } = await createProjectWithJob({
      organizationId: user.organizationId,
      userId: user.id,
      name: name || "Demo: shop-platform (intentionally flawed)",
      sourceType: "demo",
      repositoryUrl: "demo://shop-platform",
      visibility: "demo",
      ref: "demo",
    });
    await logAuditEvent({
      organizationId: user.organizationId,
      userId: user.id,
      projectId,
      action: "project.created",
      metadata: { source: "demo" },
    });
    return Response.json({ ok: true, projectId, jobId });
  }

  const parsed = parseRepoInput(body.repositoryUrl ?? "");
  if (!parsed) return Response.json({ error: "invalid_repo" }, { status: 400 });

  const { projectId, jobId } = await createProjectWithJob({
    organizationId: user.organizationId,
    userId: user.id,
    name: name || `${parsed.owner}/${parsed.repo}`,
    sourceType: "github",
    repositoryUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
    repoOwner: parsed.owner,
    repoName: parsed.repo,
    ref,
    defaultBranch: null,
  });
  await logAuditEvent({
    organizationId: user.organizationId,
    userId: user.id,
    projectId,
    action: "project.created",
    metadata: { source: "github", repository: `${parsed.owner}/${parsed.repo}`, ref },
  });
  return Response.json({ ok: true, projectId, jobId });
}
