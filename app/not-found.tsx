import type { Metadata } from "next";
import { Icon } from "@/components/icons";
import { getLocale, ts } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "404 — CodeAudit" };

/** 404 inside the app shell: localized through the same server dictionary helpers. */
export default async function NotFound() {
  const locale = await getLocale();
  const t = ts(locale);

  const pick = (key: string, ar: string, en: string): string => {
    const value = t(key);
    return value && value !== key ? value : locale === "en" ? en : ar;
  };

  const title = pick("notFound.title", "الصفحة غير موجودة", "Page not found");
  const body = pick(
    "notFound.body",
    "قد يكون الرابط قديمًا، أو أن المشروع أو التدقيق قد حُذف.",
    "The link may be out of date, or the project or the audit was deleted.",
  );

  return (
    <div className="page">
      <div className="panel">
        <div className="panel-body space-y-4">
          <span className="brand-mark h-11 w-11">
            <Icon name="search" size={20} />
          </span>

          <div>
            <p className="eyebrow">404</p>
            <h1 className="page-title">{title}</h1>
            <p className="page-sub">{body}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <a className="btn btn-primary" href="/dashboard">
              <Icon name="activity" size={15} />
              {pick("nav.dashboard", "لوحة التحكم", "Dashboard")}
            </a>
            <a className="btn" href="/">
              <Icon name="shield" size={15} />
              {pick("notFound.home", "الصفحة الرئيسية", "Home page")}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
