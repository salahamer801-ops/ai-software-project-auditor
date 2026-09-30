import { notFound, redirect } from "next/navigation";
import { getSessionUserSafe } from "@/lib/session";
import { getProjectAccess } from "@/lib/auth";
import { getJob, getProject } from "@/lib/queries";
import { buildReport } from "@/lib/report";
import { getLocale, formatDate, formatNumber } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";
import { Breadcrumbs } from "@/components/ui";
import { PrintButton } from "@/components/Actions";
import { Callout, CodeBlock, KeyValue, Panel, PageHeader, SeverityBadge, StatusBadge } from "@/components/ui";
import { Icon } from "@/components/icons";
import { TestExecutionDetails } from "@/components/TestExecution";

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ jobId: string }> }) {
  const user = await getSessionUserSafe();
  if (!user) redirect("/login");
  const { jobId } = await params;

  const job = await getJob(jobId);
  if (!job) notFound();
  const project = await getProject(job.project_id);
  if (!project) notFound();
  const access = await getProjectAccess(project.id, user.id);
  if (!access) notFound();

  const locale = await getLocale();
  const t = makeT(locale);
  const report = await buildReport(jobId);
  // An executed run is the evidence of record for the testing section; artifacts follow it.
  const executedRun = report?.tests.find((item) => item.executed) ?? null;

  const severityLabels: Record<string, string> = {
    CRITICAL: t("severity.CRITICAL"),
    HIGH: t("severity.HIGH"),
    MEDIUM: t("severity.MEDIUM"),
    LOW: t("severity.LOW"),
    INFO: t("severity.INFO"),
  };

  if (!report) {
    return (
      <div className="page">
        <PageHeader title={t("audit.failed")} />
        <Panel title={t("audit.failed")} icon="alert">
          <Callout tone="bad">{job.error_message ?? t("common.error")}</Callout>
          <a className="btn mt-4" href={`/audits/${jobId}`}>
            {t("common.back")}
          </a>
        </Panel>
      </div>
    );
  }

  const counts = report.summary?.severityCounts ?? { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  const ordered = [...report.findings].sort(
    (a, b) =>
      ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].indexOf(a.severity) -
      ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].indexOf(b.severity),
  );

  return (
    <article className="page">
      <PageHeader
        crumb={
          <Breadcrumbs
            items={[
              { label: t("nav.dashboard"), href: "/dashboard" },
              { label: report.project.name, href: `/projects/${project.id}` },
              { label: t("audit.summary"), href: `/audits/${jobId}` },
              { label: t("audit.report") },
            ]}
          />
        }
        title={`${t("audit.report")} — ${report.project.name}`}
        meta={
          <>
            <span className="mono chip chip-mono">{report.audit.sourceLabel}</span>
            {report.audit.commitSha ? (
              <span className="chip chip-mono">{report.audit.commitSha.slice(0, 10)}</span>
            ) : null}
            <span className="chip">
              <Icon name="clock" size={12} />
              {formatDate(locale, report.generatedAt)}
            </span>
          </>
        }
        actions={
          <>
            <PrintButton label={t("audit.printPdf")} />
            <a className="btn no-print" href={`/api/audits/${jobId}/report`}>
              {t("audit.exportJson")}
            </a>
            <a className="btn no-print" href={`/audits/${jobId}`}>
              {t("common.back")}
            </a>
          </>
        }
      />

      <Panel title={`1. ${t("audit.summary")}`} icon="activity">
        <p className="mt-2 text-sm leading-relaxed">{report.summary?.headline[locale]}</p>
        <div className="flex flex-wrap gap-2">
          {Object.entries(counts).map(([severity, value]) => (
            <span key={severity} className="chip">
              {severityLabels[severity] ?? severity}: <strong className="text-ink">{value}</strong>
            </span>
          ))}
        </div>
        {report.summary?.highlights && report.summary.highlights.length > 0 ? (
          <ul className="mt-4 space-y-1.5 text-sm">
            {report.summary.highlights.map((highlight, index) => (
              <li key={index}>▸ {highlight.text[locale]}</li>
            ))}
          </ul>
        ) : null}
      </Panel>

      <Panel title={`2. ${t("project.new.name")}`} icon="folder">
        <KeyValue
          items={[
            { label: t("project.new.name"), value: report.project.name },
            { label: t("project.new.source"), value: report.audit.sourceLabel },
            { label: t("audit.commit"), value: <span className="mono text-xs">{report.audit.commitSha ?? "—"}</span> },
            { label: t("audit.branch"), value: <span className="mono text-xs">{report.audit.branch ?? "—"}</span> },
            { label: t("common.of"), value: report.project.organization },
            { label: t("audit.startedAt", { when: formatDate(locale, report.audit.createdAt) }), value: `${((report.audit.durationMs ?? 0) / 1000).toFixed(1)}s` },
          ]}
        />
      </Panel>

      <Panel title={`3. ${t("project.stack")}`} icon="package">
        <KeyValue
          items={[
            {
              label: t("project.stack"),
              value: report.stack?.languages.map((lang) => `${lang.name} (${lang.files} files, ${lang.loc} loc)`).join(", ") ?? "—",
            },
            { label: t("about.enginesTitle"), value: report.stack?.frameworks.join(", ") ?? "—" },
            { label: t("deps.total"), value: report.stack?.packageManagers.join(", ") ?? "—" },
            { label: t("tests.detected"), value: report.stack?.testFrameworks.join(", ") ?? t("tests.none") },
          ]}
        />
      </Panel>

      <Panel title={`4. ${t("audit.report")} — metadata`} icon="layers">
        <KeyValue
          items={[
            { label: t("audit.engineVersion"), value: <span className="mono text-xs">{report.product.engineVersion}</span> },
            { label: t("audit.ruleHash"), value: <span className="mono text-xs">{report.product.ruleVersion}</span> },
            {
              label: t("audit.ai"),
              value: report.product.aiEnabled ? (
                <span className="mono text-xs">{report.product.aiModel ?? "configured"}</span>
              ) : (
                t("settings.aiMissing")
              ),
            },
            { label: t("dashboard.totalAudits"), value: formatNumber(locale, report.findings.length) },
          ]}
        />
        <ul className="mt-3 space-y-1 text-xs text-muted">
          {report.tools.map((tool, index) => (
            <li key={index} className="mono">
              {tool}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title={`5. ${t("deps.vulnerable")}`} icon="package">
        <KeyValue
          items={[
            { label: t("deps.total"), value: formatNumber(locale, report.dependencies.total) },
            { label: t("deps.vulnerable"), value: formatNumber(locale, report.dependencies.vulnerable) },
            { label: t("deps.outdated"), value: formatNumber(locale, report.dependencies.outdated) },
            { label: t("deps.source"), value: "OSV (api.osv.dev)" },
          ]}
        />
        {report.dependencies.items.length > 0 ? (
          <ul className="mt-3 space-y-2 text-xs">
            {report.dependencies.items.map((item, index) => (
              <li key={index} className="rounded-lg border border-line/60 p-2">
                <span className="mono">
                  {item.packageName}@{item.version}
                </span>{" "}
                <span className="text-muted">({item.ecosystem}, {item.scope})</span>
                {item.latestVersion ? <span className="text-muted"> → {item.latestVersion}</span> : null}
                <ul className="mt-1 space-y-0.5 text-muted">
                  {item.vulnerabilities.map((vulnerability) => (
                    <li key={vulnerability.advisoryId}>
                      {vulnerability.advisoryId} · {vulnerability.severity}
                      {vulnerability.fixedVersion ? ` · ${t("deps.fixedIn")} ${vulnerability.fixedVersion}` : ""} — {vulnerability.summary}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">{t("common.none")}</p>
        )}
      </Panel>

      <Panel title={`6. ${t("engine.quality")}`} icon="file">
        {report.quality ? (
          <KeyValue
            items={[
              { label: t("quality.loc"), value: formatNumber(locale, report.quality.totalLoc) },
              { label: t("quality.functions"), value: formatNumber(locale, report.quality.functions) },
              { label: t("quality.avgComplexity"), value: String(report.quality.avgComplexity) },
              { label: t("quality.maxComplexity"), value: String(report.quality.maxComplexity) },
              { label: t("quality.duplicateBlocks"), value: formatNumber(locale, report.quality.duplicateBlocks) },
              { label: t("quality.duplicateLines"), value: formatNumber(locale, report.quality.duplicateLines) },
            ]}
          />
        ) : (
          <p className="mt-2 text-sm text-muted">{t("common.none")}</p>
        )}
      </Panel>

      <Panel title={`7. ${t("project.tabs.architecture")}`} icon="layers">
        {report.architecture ? (
          <>
            <KeyValue
              items={[
                { label: t("arch.nodes"), value: formatNumber(locale, report.architecture.nodes) },
                { label: t("arch.edges"), value: formatNumber(locale, report.architecture.edges) },
                { label: t("arch.cycles"), value: formatNumber(locale, report.architecture.cycles.length) },
                { label: t("arch.coupled"), value: formatNumber(locale, report.architecture.highlyCoupled.length) },
              ]}
            />
            <ul className="mono mt-3 space-y-1 text-xs text-muted">
              {report.architecture.cycles.slice(0, 8).map((cycle, index) => (
                <li key={index}>{cycle.path.join(" → ")}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">{t("common.none")}</p>
        )}
      </Panel>

      <Panel title={`8. ${t("tests.detected")}`} icon="flask">
        <p className="section-sub mt-1">{executedRun ? t("tests.executed") : t("tests.notRun")}</p>
        {executedRun ? <TestExecutionDetails testRun={executedRun} t={t} locale={locale} /> : null}
        <ul className="mt-3 space-y-2 text-sm">
          {report.tests
            .filter((testRun) => testRun !== executedRun)
            .map((testRun, index) => (
              <li key={index} className="card-tight">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{testRun.framework}</span>
                  <StatusBadge tone={testRun.executed ? "ok" : "neutral"}>
                    {testRun.executed ? t("tests.executed") : t("audit.notVerified")}
                  </StatusBadge>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {t("tests.passed")}: {testRun.passed ?? "—"} · {t("tests.failed")}: {testRun.failed ?? "—"} ·{" "}
                  {t("tests.coverage")}: {testRun.coveragePercent ?? "—"}%
                </p>
                {testRun.sourceReference ? <p className="mono mt-1 text-xs text-muted">{testRun.sourceReference}</p> : null}
              </li>
            ))}
          {report.tests.length === 0 ? <li className="text-sm text-muted">{t("tests.none")}</li> : null}
        </ul>
      </Panel>

      <Panel title={`9. ${t("audit.findings")}`} icon="shield">
        <p className="section-sub mt-1">
          {formatNumber(locale, ordered.length)} {t("audit.findings")}
        </p>
        <ol className="mt-4 space-y-4">
          {ordered.map((finding) => (
            <li key={finding.id} className="rounded-xl border border-line/70 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h3 dir="auto" className="font-medium">{finding.title[locale]}</h3>
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={finding.severity} label={severityLabels[finding.severity]} />
                  <span className="chip mono">{finding.ruleId}</span>
                </div>
              </div>
              <p className="mono mt-1 text-xs text-muted">
                {finding.filePath}
                {finding.lineStart ? `:${finding.lineStart}${finding.lineEnd ? `-${finding.lineEnd}` : ""}` : ""}
                {finding.symbol ? ` · ${finding.symbol}` : ""}
              </p>
              <p className="mt-2 text-sm">{finding.description[locale]}</p>
              <p className="mt-2 text-sm text-muted">{finding.impact[locale]}</p>
              <p className="mt-2 text-sm">
                <strong>{t("finding.how")}</strong> {finding.recommendation[locale]}
              </p>
              {finding.evidence.length > 0 ? (
                <div className="mt-3">
                  <h4 className="text-xs font-semibold text-muted">{t("audit.evidence")}</h4>
                  {finding.evidence[0]!.snippet ? <CodeBlock code={finding.evidence[0]!.snippet} /> : null}
                  <ul className="mono mt-1 space-y-0.5 text-xs text-muted">
                    {finding.evidence.map((evidence, index) => (
                      <li key={index}>
                        [{evidence.sourceType}] {evidence.sourceReference}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {finding.ai ? (
                <div className="mt-3 rounded-lg border border-line/60 bg-surface2/30 p-3 text-sm">
                  <p className="text-xs text-muted">
                    {t(`finding.aiSource.${finding.ai.source}`)} · {finding.ai.promptVersion}
                    {finding.ai.model ? ` · ${finding.ai.model}` : ""} ·{" "}
                    {finding.ai.verificationOccurred ? t("audit.verified") : t("audit.notVerified")}
                  </p>
                  <p className="mt-2">{finding.ai.explanation[locale]}</p>
                  <p className="mt-2 text-muted">{finding.ai.remediation[locale]}</p>
                  {finding.ai.rejectedEvidenceRefs.length > 0 ? (
                    <p className="mt-2 text-xs text-critical">
                      {t("finding.rejectedRefs")}: {finding.ai.rejectedEvidenceRefs.length}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {finding.status !== "open" ? (
                <p className="mt-2 text-xs text-muted">
                  {t("finding.status")}: {finding.status}
                  {finding.severityReason ? ` — ${finding.severityReason}` : ""}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </Panel>

      <Panel title={`10. ${t("audit.limitations")}`} icon="alert">
        <ul className="mt-3 space-y-2 text-sm text-muted">
          {report.limitations.map((limitation, index) => (
            <li key={index}>• {limitation[locale]}</li>
          ))}
        </ul>
      </Panel>

      <Panel title={`11. ${t("audit.verification")}`} icon="check">
        <KeyValue
          items={[
          {
            label: t("deps.source"),
            value: report.verification.advisoriesVerified ? t("audit.verified") : t("audit.notVerified"),
          },
          {
            label: t("tests.detected"),
            value: report.verification.testsExecuted ? "executed" : t("tests.notRun"),
          },
          { label: t("finding.rejectedRefs"), value: String(report.verification.rejectedReferences) },
          { label: t("audit.startedAt", { when: formatDate(locale, report.generatedAt) }), value: report.audit.status },
          ]}
        />
      </Panel>
    </article>
  );
}
