import { isSameOrigin, logAuditEvent } from "@/lib/auth";
import { getSessionUserSafe } from "@/lib/session";
import { parseRepoInput } from "@/lib/sources/github";
import { createProjectWithJob } from "@/lib/projects";
import { httpError, oneOf, readJson, str, withRoute } from "@/lib/api/route";

interface Body {
  name?: string;
  sourceType?: "github" | "demo";
  repositoryUrl?: string;
  ref?: string;
}

const SOURCE_TYPES = ["github", "demo"] as const;

export const POST = withRoute("projects.create", async (request) => {
  if (!isSameOrigin(request)) throw httpError(403, "bad_origin");
  const user = await getSessionUserSafe();
  if (!user) throw httpError(401, "unauthorized");
  if (user.role === "viewer") throw httpError(403, "forbidden");

  const body = await readJson<Body>(request);
  const sourceType = oneOf(body.sourceType, SOURCE_TYPES, "sourceType", { optional: true }) ?? "github";
  const name = str(body.name, { field: "name", optional: true, trim: true, max: 200, clamp: true }) ?? "";
  const ref = str(body.ref, { field: "ref", optional: true, trim: true, max: 200, clamp: true }) || null;

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

  const repositoryUrl = str(body.repositoryUrl, { field: "repositoryUrl", optional: true, trim: true }) ?? "";
  const parsed = parseRepoInput(repositoryUrl);
  if (!parsed) throw httpError(400, "invalid_repo");

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
});
