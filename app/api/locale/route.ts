import { cookies } from "next/headers";
import { LOCALE_COOKIE } from "@/lib/auth";
import { oneOf, readJson, withRoute } from "@/lib/api/route";

const LOCALES = ["ar", "en"] as const;

export const POST = withRoute("locale.set", async (request) => {
  const body = await readJson<{ locale?: string }>(request);
  const locale = oneOf(body.locale, LOCALES, "locale", { optional: true, code: "invalid_locale" }) ?? "ar";
  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    maxAge: 60 * 60 * 24 * 365,
  });
  return Response.json({ ok: true, locale });
});
