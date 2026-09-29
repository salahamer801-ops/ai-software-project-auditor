import { newId, query } from "@/lib/db";
import {
  clientIp,
  createSession,
  ensurePersonalOrg,
  hashPassword,
  isRateLimited,
  isSameOrigin,
  logAuditEvent,
  recordLoginAttempt,
  setSessionCookie,
} from "@/lib/auth";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "bad_origin" }, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    email?: string;
    password?: string;
  };
  const name = (body.name ?? "").trim().slice(0, 80);
  const email = (body.email ?? "").trim().toLowerCase().slice(0, 200);
  const password = body.password ?? "";
  const ip = clientIp(request);

  if (!name) return Response.json({ error: "name_required" }, { status: 400 });
  if (!EMAIL_RE.test(email)) return Response.json({ error: "invalid_email" }, { status: 400 });
  if (password.length < 8) return Response.json({ error: "weak_password" }, { status: 400 });
  if (await isRateLimited(email, ip, "register")) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const existing = await query<{ id: string }>(`select id from users where lower(email) = $1 limit 1`, [email]);
  if (existing.length > 0) {
    await recordLoginAttempt(email, ip, false, "register");
    return Response.json({ error: "email_taken" }, { status: 409 });
  }

  const userId = newId("usr");
  try {
    await query(
      `insert into users (id, name, email, password_hash) values ($1, $2, $3, $4)`,
      [userId, name, email, hashPassword(password)],
    );
  } catch {
    return Response.json({ error: "email_taken" }, { status: 409 });
  }
  const org = await ensurePersonalOrg(userId, name);
  const session = await createSession(userId, {
    userAgent: request.headers.get("user-agent"),
    ip,
  });
  await setSessionCookie(session.token, session.expiresAt);
  await recordLoginAttempt(email, ip, true, "register");
  await logAuditEvent({ organizationId: org.id, userId, action: "user.registered" });
  return Response.json({ ok: true, userId });
}
