"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "./I18nProvider";
import { Callout } from "./ui";
import { Icon } from "./icons";

const ERROR_KEYS: Record<string, string> = {
  invalid_credentials: "auth.invalid",
  email_taken: "auth.emailTaken",
  weak_password: "auth.weakPassword",
  invalid_email: "auth.invalidEmail",
  name_required: "auth.needName",
  rate_limited: "auth.rateLimited",
};

export function AuthForm({ mode, autoDemo = false }: { mode: "login" | "register"; autoDemo?: boolean }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autoStarted = useRef(false);

  async function submit(payload: { name?: string; email?: string; password?: string; demo?: boolean }, endpoint: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(t(ERROR_KEYS[data.error ?? ""] ?? "common.error"));
        setBusy(false);
        return;
      }
      window.location.href = "/dashboard";
    } catch {
      setError(t("common.error"));
      setBusy(false);
    }
  }

  useEffect(() => {
    if (autoDemo && !autoStarted.current) {
      autoStarted.current = true;
      void submit({ demo: true }, "/api/auth/login");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDemo]);

  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      <div className="text-center">
        <span className="brand-mark mx-auto h-10 w-10">
          <Icon name="shield" size={20} />
        </span>
      </div>
      <div className="panel">
        <div className="panel-body">
        <h1 className="page-title text-center">
          {mode === "register" ? t("auth.registerTitle") : t("auth.loginTitle")}
        </h1>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(
              mode === "register" ? { name, email, password } : { email, password },
              mode === "register" ? "/api/auth/register" : "/api/auth/login",
            );
          }}
        >
          {mode === "register" ? (
            <div>
              <label className="label" htmlFor="auth-name">
                {t("auth.name")}
              </label>
              <input
                id="auth-name"
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                required
              />
            </div>
          ) : null}
          <div>
            <label className="label" htmlFor="auth-email">
              {t("auth.email")}
            </label>
            <input
              id="auth-email"
              type="email"
              className="input"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="auth-password">
              {t("auth.password")}
            </label>
            <input
              id="auth-password"
              type="password"
              className="input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              minLength={mode === "register" ? 8 : undefined}
              required
            />
            {mode === "register" ? <p className="hint">{t("auth.passwordHint")}</p> : null}
          </div>

          {error ? <Callout tone="bad">{error}</Callout> : null}

          <button type="submit" className="btn btn-primary btn-lg w-full" disabled={busy}>
            {busy ? t("common.loading") : mode === "register" ? t("auth.register") : t("auth.login")}
          </button>
        </form>

        <div className="divider mt-5 pt-4">
          <button
            type="button"
            className="btn btn-soft w-full"
            disabled={busy}
            onClick={() => void submit({ demo: true }, "/api/auth/login")}
          >
            <Icon name="sparkles" size={15} />
            {t("auth.demoSession")}
          </button>
          <p className="hint text-center">{t("auth.demoHint")}</p>
        </div>
        </div>
      </div>

      <p className="text-center text-sm text-muted">
        <a className="link" href={mode === "register" ? "/login" : "/register"}>
          {mode === "register" ? t("auth.haveAccount") : t("auth.noAccount")}
        </a>
      </p>
    </div>
  );
}
