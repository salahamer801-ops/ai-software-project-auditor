import { clearSessionCookie, isSameOrigin } from "@/lib/auth";
import { httpError, withRoute } from "@/lib/api/route";

export const POST = withRoute("auth.logout", async (request) => {
  if (!isSameOrigin(request)) throw httpError(403, "bad_origin");
  await clearSessionCookie();
  return Response.json({ ok: true });
});
