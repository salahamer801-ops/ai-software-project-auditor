"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "./I18nProvider";
import { Callout, Panel, Progress, StatusBadge } from "./ui";
import { Icon } from "./icons";

interface StageEvent {
  type: string;
  stage?: string;
  progress?: number;
  message?: { ar: string; en: string };
  detail?: string | null;
  status?: string;
  runId?: string | null;
  findings?: number;
  error?: string;
}

const STAGE_ORDER = [
  "CLONING",
  "DETECTING",
  "ANALYZING",
  "SECURITY_SCAN",
  "DEPENDENCY_SCAN",
  "TESTING",
  "ARCHITECTURE",
  "AI_REVIEW",
  "VERIFYING",
  "REPORTING",
  "COMPLETED",
];

export function AuditProgress({
  jobId,
  initialStatus,
  initialProgress,
  initialStages,
}: {
  jobId: string;
  initialStatus: string;
  initialProgress: number;
  initialStages: { stage: string; at: string; detail?: string | null }[];
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [progress, setProgress] = useState(initialProgress);
  const [detail, setDetail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [stages, setStages] = useState(initialStages.map((stage) => stage.stage));
  const started = useRef(false);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const response = await fetch(`/api/audits/${jobId}/run`, { method: "POST" });
      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? "audit_failed");
        setRunning(false);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: StageEvent;
          try {
            event = JSON.parse(line) as StageEvent;
          } catch {
            continue;
          }
          if (event.type === "progress" && event.stage) {
            setStatus(event.stage);
            setProgress(event.progress ?? 0);
            setDetail(event.detail ?? null);
            setStages((current) => (current.includes(event.stage!) ? current : [...current, event.stage!]));
          } else if (event.type === "done") {
            setStatus(event.status ?? "COMPLETED");
            setProgress(100);
            if (event.status === "FAILED") setError(event.error ?? "audit_failed");
          } else if (event.type === "error") {
            setError(event.error ?? "audit_failed");
          }
        }
      }
    } catch {
      setError("audit_failed");
    } finally {
      setRunning(false);
      router.refresh();
    }
  }, [jobId, router]);

  useEffect(() => {
    if (started.current) return;
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(initialStatus)) return;
    started.current = true;
    void run();
  }, [initialStatus, run]);

  const finished = status === "COMPLETED";

  return (
    <Panel
      title={t("audit.progress")}
      icon="activity"
      action={
        <>
          <StatusBadge tone={finished ? "ok" : status === "FAILED" ? "bad" : "warn"}>{status}</StatusBadge>
          {!finished && status !== "FAILED" ? (
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={async () => {
                await fetch(`/api/audits/${jobId}/cancel`, { method: "POST" });
                setStatus("CANCELLED");
                router.refresh();
              }}
            >
              {t("audit.cancel")}
            </button>
          ) : null}
        </>
      }
    >
      <div aria-live="polite">
        <div className="flex items-center gap-3">
          <div className="h-1.5 flex-1">
            <Progress value={progress} tone={finished ? "ok" : "info"} />
          </div>
          <span className="mono text-xs text-muted">{Math.round(progress)}%</span>
        </div>
        {detail ? <p className="mono mt-2 truncate text-xs text-muted">{detail}</p> : null}

        <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {STAGE_ORDER.map((stage) => {
            const done = stages.includes(stage) && stage !== status;
            const active = stage === status;
            return (
              <li
                key={stage}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                  active ? "border-brand/40 bg-brand/5" : done ? "border-line/70 bg-surface2/35" : "border-line/40"
                }`}
              >
                <Icon
                  name={done || finished ? "check" : active ? "refresh" : "clock"}
                  size={14}
                  className={active ? "text-brand" : done || finished ? "text-brand/70" : "text-muted"}
                />
                <span className={active ? "text-ink" : "text-muted"}>{t(`progress.${stage}`)}</span>
              </li>
            );
          })}
        </ol>

        {error ? (
          <div className="mt-4">
            <Callout tone="bad" title={t("audit.failed")}>
              <span className="mono text-xs">{error}</span>
            </Callout>
          </div>
        ) : null}

        {!running && !finished && !error ? (
          <button type="button" className="btn btn-primary mt-4" onClick={() => void run()}>
            <Icon name="refresh" size={15} />
            {t("common.retry")}
          </button>
        ) : null}

        {finished ? (
          <p className="mt-4 text-sm text-brand">
            {locale === "ar" ? "اكتمل التدقيق — تُحدَّث النتائج أدناه." : "Audit completed — the results below are now refreshed."}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

export function RunAuditButton({ projectId, label }: { projectId: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="btn btn-primary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const response = await fetch(`/api/projects/${projectId}/audits`, { method: "POST" });
        const data = (await response.json().catch(() => ({}))) as { jobId?: string };
        if (data.jobId) {
          router.push(`/audits/${data.jobId}`);
          return;
        }
        setBusy(false);
        alert(t("common.error"));
      }}
    >
      <Icon name="refresh" size={15} />
      {busy ? t("common.loading") : label}
    </button>
  );
}
