import { query } from "../db";
import { demoSnapshot } from "../demo/demo-repo";
import { buildSnapshot } from "../sources/snapshot";
import { extractArchive, type ExtractResult } from "../sources/extract";
import { fetchRepoArchive, githubTokenConfigured } from "../sources/github";
import { ANALYSIS_LIMITS, type RawFinding, type RepoSnapshot } from "../types";
import type { EngineContext } from "../engines/shared";

/**
 * Stage 3–4 (§14): create the workspace view of the project and clone at the exact commit.
 *
 * Nothing here writes to disk or executes project code: the archive is parsed in memory and
 * becomes a file manifest (§56 — a repository is untrusted input).
 */
export async function loadSnapshot(
  projectId: string,
  sourceType: string,
  repoOwner: string | null,
  repoName: string | null,
  ref: string | null,
): Promise<{ snapshot: RepoSnapshot; extract: ExtractResult | null }> {
  if (sourceType === "demo") {
    return { snapshot: demoSnapshot(), extract: null };
  }
  if (sourceType === "github") {
    if (!repoOwner || !repoName) throw new Error("repository_missing");
    const token = githubTokenConfigured() ? process.env.GITHUB_TOKEN!.trim() : null;
    const archive = await fetchRepoArchive({ owner: repoOwner, repo: repoName, ref }, token);
    const extract = extractArchive(archive.buffer, "repository.tar.gz", {
      maxEntries: ANALYSIS_LIMITS.maxFiles,
      maxTotalBytes: 40 * 1024 * 1024,
    });
    const snapshot = buildSnapshot(
      extract.entries,
      {
        type: "github",
        label: `${archive.repositoryUrl}@${archive.revision}`,
        repositoryUrl: archive.repositoryUrl,
        owner: repoOwner,
        repo: repoName,
        ref: archive.revision,
        commitSha: archive.commitSha ?? undefined,
        bytes: archive.buffer.length,
      },
      extract.skipped,
      ANALYSIS_LIMITS,
    );
    return { snapshot, extract };
  }

  // Uploaded archive, stored with the project so the audit can be re-run later.
  const rows = await query<{ bytes: Buffer; filename: string | null }>(
    `select bytes, filename from project_sources where project_id = $1 order by created_at desc limit 1`,
    [projectId],
  );
  const row = rows[0];
  if (!row?.bytes) throw new Error("no_source_archive");
  const extract = extractArchive(Buffer.from(row.bytes), row.filename ?? "project.zip", {
    maxEntries: ANALYSIS_LIMITS.maxFiles,
    maxTotalBytes: 40 * 1024 * 1024,
  });
  const snapshot = buildSnapshot(
    extract.entries,
    {
      type: "upload",
      label: row.filename ?? "uploaded archive",
      ref: ref ?? "upload",
      bytes: row.bytes.length,
    },
    extract.skipped,
    ANALYSIS_LIMITS,
  );
  return { snapshot, extract };
}

/** What every engine receives: the manifest, the text files, an emit sink and a deadline. */
export function makeContext(
  snapshot: RepoSnapshot,
  findings: { push: (finding: RawFinding) => void },
  notes: string[],
  deadline: number,
): EngineContext {
  return {
    snapshot,
    files: snapshot.files.filter((file) => file.text && typeof file.content === "string"),
    emit: findings.push,
    note: (message: string) => notes.push(message),
    deadline,
  };
}
