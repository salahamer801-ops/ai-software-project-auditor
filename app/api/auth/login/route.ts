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
import { httpError, readJson, str, withRoute } from "@/lib/api/route";

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
}

interface LoginBody {
  email?: string;
  password?: string;
  demo?: boolean;
}

export const POST = withRoute("auth.login", async (request) => {
  if (!isSameOrigin(request)) throw httpError(403, "bad_origin");
  const body = await readJson<LoginBody>(request);
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

  const email = str(body.email, { field: "email", optional: true, trim: true, lower: true, max: 200, clamp: true }) ?? "";
  const password = str(body.password, { field: "password", optional: true }) ?? "";
  if (!email || !password) throw httpError(400, "invalid_credentials");
  if (await isRateLimited(email, ip, "login")) throw httpError(429, "rate_limited");

  const rows = await query<UserRow>(
    `select id, name, email, password_hash from users where lower(email) = $1 limit 1`,
    [email],
  );
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    await recordLoginAttempt(email, ip, false, "login");
    throw httpError(401, "invalid_credentials");
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
});
