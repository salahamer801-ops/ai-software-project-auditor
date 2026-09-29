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
  verifyPassword,
} from "@/lib/auth";

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "bad_origin" }, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    demo?: boolean;
  };
  const ip = clientIp(request);

  // Instant demo session: no email, no signup — a throw-away account so anyone can
  // see the full product (and the demo repository) immediately.
  if (body.demo) {
    const id = newId("usr");
    const name = "Demo developer";
    const email = `demo.${id.slice(-10)}@demo.local`;
    await query(
      `insert into users (id, name, email, password_hash, is_demo) values ($1, $2, $3, $4, true)`,
      [id, name, email, hashPassword(newId("pw"))],
    );
    const org = await ensurePersonalOrg(id, name);
    const session = await createSession(id, {
      userAgent: request.headers.get("user-agent"),
      ip,
    });
    await setSessionCookie(session.token, session.expiresAt);
    await logAuditEvent({ organizationId: org.id, userId: id, action: "user.demo_session" });
    return Response.json({ ok: true, demo: true });
  }

  const email = (body.email ?? "").trim().toLowerCase().slice(0, 200);
  const password = body.password ?? "";
  if (!email || !password) return Response.json({ error: "invalid_credentials" }, { status: 400 });
  if (await isRateLimited(email, ip, "login")) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const rows = await query<UserRow>(
    `select id, name, email, password_hash from users where lower(email) = $1 limit 1`,
    [email],
  );
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    await recordLoginAttempt(email, ip, false, "login");
    return Response.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const org = await ensurePersonalOrg(user.id, user.name);
  const session = await createSession(user.id, {
    userAgent: request.headers.get("user-agent"),
    ip,
  });
  await setSessionCookie(session.token, session.expiresAt);
  await recordLoginAttempt(email, ip, true, "login");
  await logAuditEvent({ organizationId: org.id, userId: user.id, action: "user.logged_in" });
  return Response.json({ ok: true, userId: user.id });
}
