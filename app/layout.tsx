import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { APP_NAME, ENGINE_VERSION, RULE_CATALOG_VERSION } from "@/lib/types";
import { getLocale, dirFor } from "@/lib/i18n/server";
import { getSessionUserSafe } from "@/lib/session";
import { I18nProvider } from "@/components/I18nProvider";
import { TopNav } from "@/components/TopNav";
import { t } from "@/lib/i18n/dict";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `${APP_NAME} — Software project auditing`,
  description:
    "Deterministic static analysis, evidence-backed findings and explanatory AI for software projects.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#070b14",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const user = await getSessionUserSafe();
  const dir = dirFor(locale);

  return (
    <html lang={locale} dir={dir}>
      <body>
        <I18nProvider locale={locale}>
          <div className="flex min-h-dvh flex-col">
            <TopNav user={user ? { name: user.name, email: user.email } : null} />
            <main className="shell flex-1 py-6">{children}</main>
            <footer className="no-print mt-8 border-t border-line/70 py-6">
              <div className="shell flex flex-col gap-2 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
                <p>
                  <span className="font-medium text-ink">{APP_NAME}</span> — {t(locale, "app.tagline")}
                </p>
                <p className="mono flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>engine {ENGINE_VERSION}</span>
                  <span>rules {RULE_CATALOG_VERSION}</span>
                  <a className="link" href="/privacy">
                    {t(locale, "nav.privacy")}
                  </a>
                  <a className="link" href="/about">
                    {t(locale, "nav.about")}
                  </a>
                </p>
              </div>
            </footer>
          </div>
        </I18nProvider>
      </body>
    </html>
  );
}
