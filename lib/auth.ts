import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { newId, query } from "./db";

export const SESSION_COOKIE = "apx_session";
export const LOCALE_COOKIE = "apx_locale";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export type Role = "owner" | "admin" | "developer" | "viewer";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  locale: string;
  isDemo: boolean;
  organizationId: string;
  organizationName: string;
  role: Role;
}

/* ------------------------------------------------------------------ */
/* Passwords                                                          */
/* ------------------------------------------------------------------ */

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$16384$8$1$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, , , , salt, hash] = stored.split("$");
    if (scheme !== "scrypt" || !salt || !hash) return false;
    const derived = scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Sessions                                                           */
/* ------------------------------------------------------------------ */

export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    `insert into sessions (id, user_id, token_hash, user_agent, ip, expires_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      newId("ses"),
      userId,
      sha256(token),
      (meta.userAgent ?? "").slice(0, 300) || null,
      (meta.ip ?? "").slice(0, 60) || null,
      expiresAt.toISOString(),
    ],
  );
  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await query(`update sessions set revoked_at = now() where token_hash = $1`, [sha256(token)]);
  }
}

interface SessionRow {
  session_id: string;
  user_id: string;
  name: string;
  email: string;
  locale: string;
  is_demo: boolean;
  organization_id: string;
  organization_name: string;
  role: string;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const rows = await query<SessionRow>(
    `select s.id as session_id, u.id as user_id, u.name, u.email, u.locale, u.is_demo,
            o.id as organization_id, o.name as organization_name, m.role
       from sessions s
       join users u on u.id = s.user_id
       left join organizations o on o.owner_id = u.id
       left join organization_members m on m.organization_id = o.id and m.user_id = u.id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()
      limit 1`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;
  await query(`update sessions set last_seen_at = now() where id = $1`, [row.session_id]).catch(() => undefined);
  if (!row.organization_id) {
    const org = await ensurePersonalOrg(row.user_id, row.name);
    return {
      id: row.user_id,
      name: row.name,
      email: row.email,
      locale: row.locale,
      isDemo: row.is_demo,
      organizationId: org.id,
      organizationName: org.name,
      role: "owner",
    };
  }
  return {
    id: row.user_id,
    name: row.name,
    email: row.email,
    locale: row.locale,
    isDemo: row.is_demo,
    organizationId: row.organization_id,
    organizationName: row.organization_name ?? "Personal",
    role: (row.role as Role) ?? "owner",
  };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireApiUser(): Promise<SessionUser | null> {
  return getSessionUser();
}

export async function ensurePersonalOrg(userId: string, name: string): Promise<{ id: string; name: string }> {
  const existing = await query<{ id: string; name: string }>(
    `select id, name from organizations where owner_id = $1 order by created_at asc limit 1`,
    [userId],
  );
  if (existing[0]) return existing[0];
  const id = newId("org");
  const orgName = name.trim() ? name.trim() : "Personal workspace";
  const slug = `org-${id.slice(-10)}`;
  await query(`insert into organizations (id, name, slug, owner_id) values ($1, $2, $3, $4)`, [
    id,
    orgName,
    slug,
    userId,
  ]);
  await query(
    `insert into organization_members (id, organization_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [newId("mem"), id, userId],
  );
  return { id, name: orgName };
}

/* ------------------------------------------------------------------ */
/* Authorisation                                                      */
/* ------------------------------------------------------------------ */

const ROLE_RANK: Record<Role, number> = { viewer: 1, developer: 2, admin: 3, owner: 4 };

export interface ProjectAccess {
  id: string;
  organizationId: string;
  role: Role;
  name: string;
  slug: string;
  sourceType: string;
  repositoryUrl: string | null;
  repoOwner: string | null;
  repoName: string | null;
  defaultBranch: string | null;
}

export async function getProjectAccess(projectId: string, userId: string): Promise<ProjectAccess | null> {
  const rows = await query<{
    id: string;
    organization_id: string;
    role: string;
    name: string;
    slug: string;
    source_type: string;
    repository_url: string | null;
    repo_owner: string | null;
    repo_name: string | null;
    default_branch: string | null;
  }>(
    `select p.id, p.organization_id, m.role, p.name, p.slug, p.source_type,
            p.repository_url, p.repo_owner, p.repo_name, p.default_branch
       from projects p
       join organization_members m on m.organization_id = p.organization_id
      where p.id = $1 and p.deleted_at is null and m.user_id = $2
      limit 1`,
    [projectId, userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    role: (row.role as Role) ?? "viewer",
    name: row.name,
    slug: row.slug,
    sourceType: row.source_type,
    repositoryUrl: row.repository_url,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    defaultBranch: row.default_branch,
  };
}

export function hasRole(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export async function requireProjectAccess(
  projectId: string,
  userId: string,
  minimum: Role,
): Promise<ProjectAccess | null> {
  const access = await getProjectAccess(projectId, userId);
  if (!access) return null;
  return hasRole(access.role, minimum) ? access : null;
}

/* ------------------------------------------------------------------ */
/* Request hardening                                                  */
/* ------------------------------------------------------------------ */

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  // Browsers tell us how the request was initiated and scripts cannot forge it: a
  // same-origin fetch is trusted even when a proxy rewrites Host/Origin.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "same-origin" || fetchSite === "none") return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  const candidates = [
    request.headers.get("x-forwarded-host"),
    request.headers.get("host"),
    process.env.MYTHEX_WEB_ORIGIN ? safeHost(process.env.MYTHEX_WEB_ORIGIN) : null,
  ].filter((value): value is string => Boolean(value));

  if (candidates.some((candidate) => candidate === originHost)) return true;

  // Proxy rewrites the host: accept the same hostname on a different port, or a
  // referer that points at the same hostname as the origin.
  const originHostname = originHost.split(":")[0];
  if (candidates.some((candidate) => candidate.split(":")[0] === originHostname)) return true;
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      if (new URL(referer).host === originHost) return true;
    } catch {
      /* ignore */
    }
  }
  if (fetchSite === "same-site") return true;
  return false;
}

function safeHost(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function recordLoginAttempt(
  email: string | null,
  ip: string,
  success: boolean,
  kind = "login",
): Promise<void> {
  await query(
    `insert into login_attempts (id, email, ip, kind, success) values ($1, $2, $3, $4, $5)`,
    [newId("att"), email ? email.toLowerCase().slice(0, 200) : null, ip.slice(0, 60), kind, success],
  );
}

export async function isRateLimited(email: string | null, ip: string, kind = "login"): Promise<boolean> {
  const rows = await query<{ failures: string }>(
    `select count(*)::text as failures
       from login_attempts
      where success = false and kind = $1 and created_at > now() - interval '15 minutes'
        and (ip = $2 or lower(coalesce(email, '')) = lower(coalesce($3, '')))`,
    [kind, ip, email ?? ""],
  );
  const failures = Number(rows[0]?.failures ?? "0");
  return failures >= 8;
}

export async function logAuditEvent(input: {
  organizationId?: string | null;
  userId?: string | null;
  projectId?: string | null;
  action: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await query(
    `insert into audit_events (id, organization_id, user_id, project_id, action, metadata)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      newId("evt"),
      input.organizationId ?? null,
      input.userId ?? null,
      input.projectId ?? null,
      input.action,
      JSON.stringify(input.metadata ?? {}),
    ],
  ).catch(() => undefined);
}

export function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9\u0621-\u064A]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || `project-${randomBytes(3).toString("hex")}`;
}
