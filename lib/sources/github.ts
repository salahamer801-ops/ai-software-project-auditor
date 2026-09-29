/**
 * GitHub source ingestion.
 *
 * We read the repository as a tarball over the REST API (never `git clone`, never a
 * postinstall script): the archive is data we parse, not code we run.
 */

export interface RepoRef {
  owner: string;
  repo: string;
  ref?: string | null;
}

export type GithubErrorCode =
  | "not_found_or_private"
  | "bad_token"
  | "rate_limited"
  | "too_large"
  | "network"
  | "unavailable";

export class GithubError extends Error {
  code: GithubErrorCode;
  constructor(code: GithubErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

const API = "https://api.github.com";
const MAX_ARCHIVE_BYTES = 45 * 1024 * 1024;

export function parseRepoInput(input: string): RepoRef | null {
  const value = input.trim();
  if (!value) return null;
  const ssh = value.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };
  const url = value.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i);
  if (url) return { owner: url[1]!, repo: url[2]!.replace(/\.git$/, "") };
  const short = value.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (short) return { owner: short[1]!, repo: short[2]!.replace(/\.git$/, "") };
  return null;
}

function headers(token?: string | null): Record<string, string> {
  const base: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "CodeAudit/1.0",
    "x-github-api-version": "2022-11-28",
  };
  if (token) base.authorization = `Bearer ${token}`;
  return base;
}

function mapStatus(status: number): GithubErrorCode {
  if (status === 404) return "not_found_or_private";
  if (status === 401) return "bad_token";
  if (status === 403 || status === 429) return "rate_limited";
  if (status === 451) return "unavailable";
  return "network";
}

export interface GithubRepoMeta {
  defaultBranch: string;
  private: boolean;
  fullName: string;
  externalId: string;
}

export async function fetchRepoMeta(ref: RepoRef, token?: string | null): Promise<GithubRepoMeta> {
  let res: Response;
  try {
    res = await fetch(`${API}/repos/${ref.owner}/${ref.repo}`, {
      headers: headers(token),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch {
    throw new GithubError("network");
  }
  if (!res.ok) throw new GithubError(mapStatus(res.status), `github meta ${res.status}`);
  const data = (await res.json()) as {
    default_branch?: string;
    private?: boolean;
    full_name?: string;
    id?: number;
  };
  return {
    defaultBranch: data.default_branch ?? "main",
    private: Boolean(data.private),
    fullName: data.full_name ?? `${ref.owner}/${ref.repo}`,
    externalId: String(data.id ?? ""),
  };
}

export async function fetchCommitSha(ref: RepoRef, revision: string, token?: string | null): Promise<string | null> {
  try {
    const res = await fetch(`${API}/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(revision)}`, {
      headers: headers(token),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { sha?: string };
    return data.sha ?? null;
  } catch {
    return null;
  }
}

export interface GithubArchive {
  buffer: Buffer;
  revision: string;
  commitSha: string | null;
  repositoryUrl: string;
  private: boolean;
}

export async function fetchRepoArchive(ref: RepoRef, token?: string | null): Promise<GithubArchive> {
  const meta = await fetchRepoMeta(ref, token);
  const revision = (ref.ref ?? "").trim() || meta.defaultBranch;

  let res: Response;
  try {
    res = await fetch(`${API}/repos/${ref.owner}/${ref.repo}/tarball/${encodeURIComponent(revision)}`, {
      headers: headers(token),
      redirect: "follow",
      signal: AbortSignal.timeout(45_000),
      cache: "no-store",
    });
  } catch {
    throw new GithubError("network");
  }
  if (!res.ok) throw new GithubError(mapStatus(res.status), `github tarball ${res.status}`);

  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_ARCHIVE_BYTES) throw new GithubError("too_large");

  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_ARCHIVE_BYTES) throw new GithubError("too_large");

  const commitSha = await fetchCommitSha(ref, revision, token);

  return {
    buffer: Buffer.from(arrayBuffer),
    revision,
    commitSha,
    repositoryUrl: `https://github.com/${ref.owner}/${ref.repo}`,
    private: meta.private,
  };
}

export function githubTokenConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim());
}
