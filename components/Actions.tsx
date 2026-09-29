"use client";

import { useState } from "react";
import { useI18n } from "./I18nProvider";
import { Callout } from "./ui";
import { Icon } from "./icons";

export function PrintButton({ label }: { label: string }) {
  return (
    <button type="button" className="btn no-print" onClick={() => window.print()}>
      <Icon name="report" size={15} />
      {label}
    </button>
  );
}

interface SelfTestResult {
  name: string;
  description: string;
  passed: boolean;
  detail: string;
}

export function SelfTestPanel() {
  const { t, locale } = useI18n();
  const [results, setResults] = useState<SelfTestResult[] | null>(null);
  const [summary, setSummary] = useState<{ passed: number; failed: number; durationMs: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/selftest", { method: "POST" });
    if (!response.ok) {
      setResults(null);
      setSummary(null);
      setError(
        response.status === 401
          ? locale === "ar"
            ? "الاختبارات الذاتية تحتاج تسجيل الدخول — سجّل الدخول ثم أعد المحاولة."
            : "The self-tests need a session — log in and try again."
          : t("common.error"),
      );
      setBusy(false);
      return;
    }
    const data = (await response.json().catch(() => ({}))) as {
      results?: SelfTestResult[];
      passed?: number;
      failed?: number;
      durationMs?: number;
    };
    setResults(data.results ?? []);
    setSummary({
      passed: data.passed ?? 0,
      failed: data.failed ?? 0,
      durationMs: data.durationMs ?? 0,
    });
    setBusy(false);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={busy}>
          <Icon name={busy ? "refresh" : "flask"} size={15} />
          {busy ? t("common.loading") : t("about.diagnosticsRun")}
        </button>
        {summary ? (
          <span className="flex flex-wrap items-center gap-2 text-xs">
            <span className="chip chip-brand">
              <Icon name="check" size={12} />
              {summary.passed} {t("about.diagnosticsPassed")}
            </span>
            <span className={`chip ${summary.failed > 0 ? "border-critical/40 text-critical" : ""}`}>
              {summary.failed} {t("about.diagnosticsFailed")}
            </span>
            <span className="text-muted">{(summary.durationMs / 1000).toFixed(2)}s</span>
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="mt-3">
          <Callout tone="warn" icon="alert">
            {error}
          </Callout>
        </div>
      ) : null}

      {results ? (
        <ul className="rows mt-3">
          {results.map((result) => (
            <li key={result.name} className="row flex-col gap-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm">
                  <Icon name={result.passed ? "check" : "close"} size={15} className={result.passed ? "text-brand" : "text-critical"} />
                  {result.description}
                </span>
                <span className="mono text-xs text-muted">{result.name}</span>
              </div>
              <p className="mono text-xs text-muted">{result.detail}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
