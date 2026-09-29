"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useI18n } from "./I18nProvider";

export function LocaleSwitch() {
  const { locale, t } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    const next = locale === "ar" ? "en" : "ar";
    await fetch("/api/locale", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: next }),
    });
    setBusy(false);
    startTransition(() => router.refresh());
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="btn btn-ghost"
      aria-label="switch language"
      disabled={busy || pending}
    >
      {t("nav.language")}
    </button>
  );
}

export function LogoutButton() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/auth/logout", { method: "POST" });
        window.location.href = "/";
      }}
    >
      {t("nav.logout")}
    </button>
  );
}

export function LoginButton() {
  const { t } = useI18n();
  return (
    <a className="btn btn-primary" href="/login">
      {t("nav.login")}
    </a>
  );
}
