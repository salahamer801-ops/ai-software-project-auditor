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
import { email as validEmail, httpError, readJson, str, withRoute } from "@/lib/api/route";

interface RegisterBody {
  name?: string;
  email?: string;
  password?: string;
}

export const POST = withRoute("auth.register", async (request) => {
  if (!isSameOrigin(request)) throw httpError(403, "bad_origin");
  const body = await readJson<RegisterBody>(request);
  const ip = clientIp(request);

  const name = str(body.name, {
    field: "name",
    trim: true,
    min: 1,
    max: 80,
    clamp: true,
    code: "name_required",
    message: "A name is required",
  });
  const email = validEmail(body.email, "email", { max: 200 });
  const password = str(body.password, {
    field: "password",
    min: 8,
    code: "weak_password",
    message: "Password must be at least 8 characters",
  });

  if (await isRateLimited(email, ip, "register")) throw httpError(429, "rate_limited");

  const existing = await query<{ id: string }>(`select id from users where lower(email) = $1 limit 1`, [email]);
  if (existing.length > 0) {
    await recordLoginAttempt(email, ip, false, "register");
    throw httpError(409, "email_taken");
  }

  const userId = newId("usr");
  try {
    await query(
      `insert into users (id, name, email, password_hash) values ($1, $2, $3, $4)`,
      [userId, name, email, hashPassword(password)],
    );
  } catch {
    throw httpError(409, "email_taken");
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
});
