import { notFound, redirect } from "next/navigation";
import { getSessionUserSafe } from "@/lib/session";
import { getProjectAccess } from "@/lib/auth";
import { getFindingDetail } from "@/lib/queries";
import { getLocale, formatDate } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";
import {
  Breadcrumbs,
  Callout,
  CodeBlock,
  KeyValue,
  Panel,
  PageHeader,
  SEVERITY_VAR,
  SeverityBadge,
  StatusBadge,
} from "@/components/ui";
import { Icon } from "@/components/icons";
import { FindingStatusControls } from "@/components/FindingStatusControls";

export const dynamic = "force-dynamic";

export default async function FindingPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUserSafe();
  if (!user) redirect("/login");
  const { id } = await params;

  const finding = await getFindingDetail(id);
  if (!finding) notFound();
  const access = await getProjectAccess(finding.project_id, user.id);
  if (!access) notFound();

  const locale = await getLocale();
  const t = makeT(locale);

  const severityLabels: Record<string, string> = {
    CRITICAL: t("severity.CRITICAL"),
    HIGH: t("severity.HIGH"),
    MEDIUM: t("severity.MEDIUM"),
    LOW: t("severity.LOW"),
    INFO: t("severity.INFO"),
  };

  const ai = finding.ai;
  const codeEvidence = finding.evidence_rows.find((row) => row.source_type === "code");
  const otherEvidence = finding.evidence_rows.filter((row) => row.source_type !== "code");
  const runHref = `/audits/${finding.run_job_id}`;
  const lineLabel = `${finding.file_path ?? "—"}${
    finding.line_start ? `:${finding.line_start}${finding.line_end && finding.line_end !== finding.line_start ? `-${finding.line_end}` : ""}` : ""
  }`;

  const answer = (label: string, body: string, icon: string) => (
    <div className="flex gap-3">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface2/60 text-muted">
        <Icon name={icon} size={15} />
      </span>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">{label}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted">{body}</p>
      </div>
    </div>
  );

  return (
    <div className="page">
      <PageHeader
        crumb={
          <Breadcrumbs
            items={[
              { label: t("nav.dashboard"), href: "/dashboard" },
              { label: finding.project_name, href: `/projects/${finding.project_id}` },
              { label: t("audit.summary"), href: runHref },
              { label: finding.rule_id },
            ]}
          />
        }
        title={<span dir="auto">{finding.title[locale]}</span>}
        meta={
          <>
            <SeverityBadge severity={finding.severity} label={severityLabels[finding.severity]} />
            <span className="chip">{t(`category.${finding.category}`)}</span>
            <span className="chip chip-mono">{finding.rule_id}</span>
            <StatusBadge tone={finding.status === "open" ? "warn" : finding.status === "fixed" ? "ok" : "neutral"}>
              {t(`finding.status.${finding.status}`)}
            </StatusBadge>
          </>
        }
        actions={
          <>
            <a className="btn" href={`/projects/${finding.project_id}?tab=findings`}>
              <Icon name="folder" size={15} />
              {finding.project_name}
            </a>
            <a className="btn" href={runHref}>
              <Icon name="report" size={15} />
              {t("audit.summary")}
            </a>
          </>
        }
      />

      <div
        className="panel px-4 py-3"
        style={{ ["--sev" as string]: SEVERITY_VAR[finding.severity] }}
      >
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="mono">{lineLabel}</span>
          {finding.symbol ? <span className="chip chip-mono">{finding.symbol}</span> : null}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr] lg:items-start">
        <div className="flex flex-col gap-5">
          <Panel title={t(`category.${finding.category}`)} icon="alert" sub={`${finding.rule_id}@${finding.rule_version}`}>
            <div className="flex flex-col gap-4">
              {answer(t("finding.what"), finding.description[locale], "alert")}
              {answer(t("finding.why"), finding.impact[locale], "activity")}
              {answer(t("finding.how"), finding.recommendation[locale], "check")}
            </div>

            <div className="divider mt-4 pt-4">
              <KeyValue
                items={[
                  { label: t("finding.where"), value: <span className="mono text-xs">{lineLabel}</span> },
                  { label: t("finding.symbol"), value: <span className="mono text-xs">{finding.symbol ?? "—"}</span> },
                  { label: t("finding.detection"), value: finding.detection_method[locale] },
                  { label: t("finding.rule"), value: <span className="mono text-xs">{finding.rule_id}@{finding.rule_version}</span> },
                  { label: t("finding.detectionConfidence"), value: `${(finding.confidence * 100).toFixed(0)}%` },
                  {
                    label: t("finding.aiConfidence"),
                    value: finding.ai_confidence !== null ? `${(finding.ai_confidence * 100).toFixed(0)}%` : "—",
                  },
                  { label: t("severity.source.rule"), value: t(`severity.source.${finding.severity_source}`) },
                  { label: t("finding.toolReference"), value: <span className="mono text-xs">{finding.tool_reference ?? "—"}</span> },
                ]}
              />
            </div>

            {finding.severity_reason ? (
              <div className="mt-4">
                <Callout tone="info" title={t("severity.source.rule")}>
                  {finding.severity_reason}
                </Callout>
              </div>
            ) : null}
          </Panel>

          <Panel
            title={t("audit.evidence")}
            icon="file"
            sub={t("finding.maskNote")}
            action={
              <span className="chip">
                {finding.evidence_rows.length} {t("common.results")}
              </span>
            }
          >
            {codeEvidence?.snippet ? (
              <CodeBlock code={codeEvidence.snippet} label={codeEvidence.source_reference} />
            ) : null}
            <div className="mt-3 space-y-2">
              {finding.evidence_rows.map((row) => (
                <details key={row.id} className="overflow-hidden rounded-lg border border-line/70 bg-surface2/25">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-xs">
                    <span className="chip">{row.source_type}</span>
                    <span className="mono truncate text-muted">{row.source_reference}</span>
                  </summary>
                  <div className="border-t border-line/60 p-3">
                    {row.snippet ? <CodeBlock code={row.snippet} /> : null}
                    {row.metadata ? (
                      <pre className="mono mt-2 overflow-auto text-xs text-muted">{JSON.stringify(row.metadata, null, 2)}</pre>
                    ) : null}
                  </div>
                </details>
              ))}
            </div>
            {otherEvidence.length === 0 && !codeEvidence ? <p className="mt-3 text-sm text-muted">{t("common.none")}</p> : null}
          </Panel>

          <Panel
            title={t("audit.ai")}
            icon="sparkles"
            action={
              <StatusBadge tone={ai?.source === "ai" ? "ok" : "neutral"}>
                {ai ? t(`finding.aiSource.${ai.source}`) : t("settings.aiMissing")}
              </StatusBadge>
            }
          >
            {ai ? (
              <div className="flex flex-col gap-4 text-sm leading-relaxed">
                <p>{ai.explanation[locale]}</p>
                <div className="divider pt-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <h3 className="eyebrow">{t("finding.why")}</h3>
                      <p className="mt-1">{ai.practicalImpact[locale]}</p>
                    </div>
                    <div>
                      <h3 className="eyebrow">{t("finding.how")}</h3>
                      <p className="mt-1">{ai.remediation[locale]}</p>
                    </div>
                  </div>
                </div>
                <div>
                  <h3 className="eyebrow">{t("finding.falsePositive")}</h3>
                  <p className="mt-1 text-muted">{ai.falsePositiveIndicators[locale]}</p>
                </div>
                <KeyValue
                  items={[
                    { label: t("finding.promptVersion"), value: <span className="mono text-xs">{ai.prompt_version}</span> },
                    { label: t("finding.model"), value: <span className="mono text-xs">{ai.model ?? t("settings.aiMissing")}</span> },
                    {
                      label: t("audit.verification"),
                      value: (
                        <StatusBadge tone={ai.verificationOccurred ? "ok" : "warn"}>
                          {ai.verificationOccurred ? t("audit.verified") : t("audit.notVerified")}
                        </StatusBadge>
                      ),
                    },
                    { label: t("finding.evidenceRefs"), value: String(ai.evidenceRefs.length) },
                  ]}
                />
                {ai.evidenceRefs.length > 0 ? (
                  <div>
                    <h3 className="eyebrow mb-1">{t("finding.evidenceRefs")}</h3>
                    <ul className="mono space-y-1 text-xs text-muted">
                      {ai.evidenceRefs.map((ref, index) => (
                        <li key={index}>
                          {ref.file}
                          {ref.line ? `:${ref.line}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {ai.rejectedEvidenceRefs.length > 0 ? (
                  <div>
                    <h3 className="eyebrow mb-1">{t("finding.rejectedRefs")}</h3>
                    <ul className="mono space-y-1 text-xs text-critical">
                      {ai.rejectedEvidenceRefs.map((ref, index) => (
                        <li key={index}>
                          {ref.file}
                          {ref.line ? `:${ref.line}` : ""} — {ref.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {ai.limitations.length > 0 ? (
                  <div>
                    <h3 className="eyebrow mb-1">{t("finding.limitations")}</h3>
                    <ul className="space-y-1 text-xs text-muted">
                      {ai.limitations.map((limitation, index) => (
                        <li key={index}>• {limitation}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <Callout tone="info">{t("settings.aiMissingHint")}</Callout>
            )}
          </Panel>
        </div>

        <div className="flex flex-col gap-5">
          <Panel title={t("finding.fixed")} icon="check">
            <FindingStatusControls
              findingId={finding.id}
              currentStatus={finding.status}
              currentReason={finding.status_reason}
            />
          </Panel>

          <Panel title={t("finding.history")} icon="clock" flush>
            {finding.events.length === 0 ? (
              <div className="panel-body">
                <p className="text-sm text-muted">{t("common.none")}</p>
              </div>
            ) : (
              <ul className="rows">
                {finding.events.map((event) => (
                  <li key={event.id} className="row flex-col gap-1">
                    <span className="mono text-xs">{event.action}</span>
                    <span className="text-xs text-muted">{formatDate(locale, event.created_at)}</span>
                    {event.reason ? <p className="text-xs text-muted">{event.reason}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={t("finding.occurrences")} icon="layers">
            <KeyValue
              items={[
                { label: t("finding.fingerprint"), value: <span className="mono text-xs">{finding.fingerprint}</span> },
                { label: t("finding.occurrences"), value: String(finding.occurrences) },
                { label: t("audit.commit"), value: <span className="mono text-xs">{finding.run_commit ?? "—"}</span> },
                { label: t("audit.summary"), value: formatDate(locale, finding.run_created_at) },
              ]}
            />
            <p className="hint">{t("finding.fingerprintHint")}</p>
            <a className="btn mt-3" href={runHref}>
              <Icon name="report" size={15} />
              {t("audit.summary")}
            </a>
          </Panel>
        </div>
      </div>
    </div>
  );
}
