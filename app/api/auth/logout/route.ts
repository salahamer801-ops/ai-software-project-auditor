import { clearSessionCookie, isSameOrigin } from "@/lib/auth";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "bad_origin" }, { status: 403 });
  }
  await clearSessionCookie();
  return Response.json({ ok: true });
}
