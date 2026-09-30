"use client";

import { useEffect } from "react";
import { useI18n } from "@/components/I18nProvider";
import { Icon } from "@/components/icons";
import { DICT } from "@/lib/i18n/dict";
import { logger } from "@/lib/observability/log";
import type { Locale } from "@/lib/types";

/**
 * Unexpected render error inside the app shell. The root layout (and therefore the
 * language provider) is still mounted, so the copy comes from the dictionary; if a key
 * is ever missing the static Arabic/English fallback below keeps the page readable.
 */
export default function ErrorScreen({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { locale, t } = useI18n();
  const other: Locale = locale === "ar" ? "en" : "ar";

  useEffect(() => {
    // Structured client-side line: message + digest only, never the stack.
    logger.error("ui.error_boundary", {
      message: error?.message,
      digest: error?.digest,
      path: typeof window === "undefined" ? undefined : window.location.pathname,
    });
  }, [error]);

  const pick = (key: string, ar: string, en: string): string => {
    const value = t(key);
    return value && value !== key ? value : locale === "en" ? en : ar;
  };
  const otherText = (key: string, ar: string, en: string): string => {
    const entry = DICT[key];
    return entry?.[other] ?? (other === "en" ? en : ar);
  };

  return (
    <div className="page">
      <div className="panel">
        <div className="panel-body space-y-4">
          <span className="brand-mark h-11 w-11">
            <Icon name="alert" size={20} />
          </span>

          <div>
            <h1 className="page-title">{pick("error.title", "حدث خطأ غير متوقع", "Something went wrong")}</h1>
            <p className="page-sub">
              {pick(
                "error.body",
                "لم نتمكن من عرض هذا القسم. جرّب مرة أخرى، وإن تكرّر الخطأ فعُد إلى لوحة التحكم.",
                "We could not render this section. Try again, and if it keeps happening go back to the dashboard.",
              )}
            </p>
            <p className="hint mt-2" dir={other === "ar" ? "rtl" : "ltr"}>
              {otherText(
                "error.body",
                "لم نتمكن من عرض هذا القسم. جرّب مرة أخرى، وإن تكرّر الخطأ فعُد إلى لوحة التحكم.",
                "We could not render this section. Try again, and if it keeps happening go back to the dashboard.",
              )}
            </p>
          </div>

          {error?.digest ? (
            <p className="mono text-xs text-muted">
              {pick("error.digest", "معرّف الخطأ", "Error reference")}: {error.digest}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="button" className="btn btn-primary" onClick={() => reset()}>
              <Icon name="refresh" size={15} />
              {pick("common.retry", "إعادة المحاولة", "Try again")}
            </button>
            <a className="btn" href="/dashboard">
              <Icon name="activity" size={15} />
              {pick("nav.dashboard", "لوحة التحكم", "Dashboard")}
            </a>
            <a className="btn btn-ghost" href="/">
              {pick("notFound.home", "الصفحة الرئيسية", "Home page")}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
