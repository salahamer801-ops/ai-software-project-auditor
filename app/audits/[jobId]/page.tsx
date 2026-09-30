import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getSessionUserSafe } from "@/lib/session";
import { getProjectAccess } from "@/lib/auth";
import { getLocale, formatDate, formatNumber } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";
import { getJob, getProject, getRunByJob, listDependencies, listFindings, listTestRuns } from "@/lib/queries";
import { AuditProgress } from "@/components/AuditProgress";
import { FindingsList, type FindingListItem } from "@/components/FindingsList";
import { TestExecutionDetails } from "@/components/TestExecution";
import {
  Breadcrumbs,
  Callout,
  EmptyState,
  Field,
  KeyValue,
  Panel,
  PageHeader,
  SeverityBars,
  StatTile,
  StatusBadge,
  Toolbar,
} from "@/components/ui";
import { Icon } from "@/components/icons";
import { CATEGORIES, SEVERITIES, type Severity } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Audit — CodeAudit" };

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<{ severity?: string; category?: string; status?: string; q?: string }>;
}) {
  const user = await getSessionUserSafe();
  if (!user) redirect("/login");
  const { jobId } = await params;
  const filters = await searchParams;

  const job = await getJob(jobId);
  if (!job) notFound();
  const project = await getProject(job.project_id);
  if (!project) notFound();
  const access = await getProjectAccess(project.id, user.id);
  if (!access) notFound();

  const locale = await getLocale();
  const t = makeT(locale);
  const run = await getRunByJob(jobId);

  const severityLabels: Record<string, string> = {
    CRITICAL: t("severity.CRITICAL"),
    HIGH: t("severity.HIGH"),
    MEDIUM: t("severity.MEDIUM"),
    LOW: t("severity.LOW"),
    INFO: t("severity.INFO"),
  };
  const statusLabels: Record<string, string> = {
    open: t("finding.status.open"),
    confirmed: t("finding.status.confirmed"),
    false_positive: t("finding.status.false_positive"),
    ignored: t("finding.status.ignored"),
    fixed: t("finding.status.fixed"),
  };
  const categoryLabels = Object.fromEntries(CATEGORIES.map((category) => [category, t(`category.${category}`)]));

  const finished = run?.status === "COMPLETED";
  const [findings, dependencies, testRuns] = finished
    ? await Promise.all([
        listFindings(run!.id, {
          severity: (filters.severity as Severity | undefined) ?? "all",
          category: filters.category ?? "all",
          status: filters.status ?? "all",
          search: filters.q,
          limit: 400,
        }),
        listDependencies(run!.id),
        listTestRuns(run!.id),
      ])
    : [[], [], []];

  const summary = run?.summary ?? null;
  const counts = (summary?.severityCounts ?? { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 }) as Record<string, number>;
  const totalCount = Object.values(counts).reduce((acc, value) => acc + value, 0);
  const vulnerableDeps = dependencies.filter((item) => (item.vulnerabilities?.length ?? 0) > 0);
  const outdatedDeps = dependencies.filter((item) => item.outdated);
  const failedTests = testRuns.reduce((acc, item) => acc + (item.failed ?? 0), 0);
  const coverage = testRuns.find((item) => item.coveragePercent !== null)?.coveragePercent ?? null;
  // The executed run (when tests were allowed to run) leads the panel; committed artifacts follow.
  const executedRun = testRuns.find((item) => item.executed) ?? null;
  const otherRuns = testRuns.filter((item) => item !== executedRun);
  const architecture = run?.stats?.architecture ?? null;
  const quality = run?.stats?.quality ?? null;
  const engines = run?.engines ?? [];
  const stats = run?.stats as { advisoriesVerified?: boolean } | null;

  const verdictTone: "ok" | "warn" | "bad" =
    summary?.status === "CLEAN" ? "ok" : summary?.status === "CRITICAL" || summary?.status === "ACTION_REQUIRED" ? "bad" : "warn";

  const hasFilters = Boolean(filters.severity || filters.category || filters.status || filters.q);

  const findingItems: FindingListItem[] = findings.map((finding) => ({
    id: finding.id,
    ruleId: finding.rule_id,
    category: finding.category,
    severity: finding.severity,
    status: finding.status,
    title: finding.title,
    filePath: finding.file_path,
    lineStart: finding.line_start,
    symbol: finding.symbol,
    confidence: finding.confidence,
    occurrences: Number(finding.metadata?.occurrences ?? 1),
  }));

  return (
    <div className="page">
      <PageHeader
        crumb={
          <Breadcrumbs
            items={[
              { label: t("nav.dashboard"), href: "/dashboard" },
              { label: project.name, href: `/projects/${project.id}` },
              { label: t("audit.summary") },
            ]}
          />
        }
        title={t("audit.summary")}
        meta={
          <>
            <StatusBadge tone={finished ? "ok" : job.status === "FAILED" ? "bad" : "warn"}>{job.status}</StatusBadge>
            <span className="chip">
              <Icon name="clock" size={12} />
              {formatDate(locale, run?.created_at ?? job.created_at)}
            </span>
            {run?.duration_ms ? (
              <span className="chip">
                {(run.duration_ms / 1000).toFixed(1)}
                {t("common.seconds")}
              </span>
            ) : null}
            <span className="chip chip-mono">{(run?.commit_sha ?? job.commit_sha ?? "—").slice(0, 10)}</span>
            <span className="chip chip-mono">{run?.branch ?? job.branch ?? "—"}</span>
          </>
        }
        actions={
          finished ? (
            <>
              <a className="btn btn-primary" href={`/audits/${jobId}/report`}>
                <Icon name="report" size={15} />
                {t("audit.openReport")}
              </a>
              <a className="btn" href={`/api/audits/${jobId}/report`}>
                {t("audit.exportJson")}
              </a>
              <a className="btn" href={`/projects/${project.id}?tab=history`}>
                {t("project.tabs.history")}
              </a>
            </>
          ) : (
            <a className="btn" href={`/projects/${project.id}`}>
              {project.name}
            </a>
          )
        }
      />

      <AuditProgress
        jobId={jobId}
        initialStatus={job.status}
        initialProgress={job.progress}
        initialStages={(job.stages as { stage: string; at: string; detail?: string | null }[] | null) ?? []}
      />

      {job.status === "FAILED" ? (
        <Panel title={t("audit.failed")} icon="alert">
          <Callout tone="bad" title={t("audit.failed")}>
            <span className="mono text-xs">{job.error_message}</span>
          </Callout>
          <p className="mt-3 text-sm text-muted">{t("project.new.invalidRepo")}</p>
        </Panel>
      ) : null}

      {finished && summary ? (
        <>
          <Panel
            title={t("audit.keyMetrics")}
            icon="activity"
            sub={summary.stackHighlights.join(" · ") || undefined}
            action={
              <StatusBadge tone={verdictTone}>
                {summary.status.replaceAll("_", " ")}
              </StatusBadge>
            }
          >
            <p className="text-sm leading-relaxed">{summary.headline[locale]}</p>
            <div className="mt-4">
              <SeverityBars counts={counts} labels={severityLabels} total={totalCount} />
            </div>
            <div className="tiles mt-4">
              <StatTile label={t("quality.loc")} value={formatNumber(locale, summary.loc)} icon="file" />
              <StatTile label={t("common.files")} value={formatNumber(locale, summary.filesAnalyzed)} icon="folder" />
              <StatTile
                label={t("deps.vulnerable")}
                value={formatNumber(locale, vulnerableDeps.length)}
                tone={vulnerableDeps.length > 0 ? "bad" : "ok"}
                icon="package"
              />
              <StatTile
                label={t("tests.failed")}
                value={failedTests > 0 ? formatNumber(locale, failedTests) : coverage !== null ? `${coverage}%` : "—"}
                tone={failedTests > 0 ? "bad" : "neutral"}
                hint={coverage !== null ? `${t("tests.coverage")}: ${coverage}%` : t("tests.notRun")}
                icon="flask"
              />
            </div>

            {summary.highlights.length > 0 ? (
              <div className="divider mt-4 pt-4">
                <h3 className="eyebrow mb-2">{t("dashboard.criticalFindings")}</h3>
                <ul className="space-y-1.5">
                  {summary.highlights.map((highlight, index) => (
                    <li key={index} className="flex items-start gap-2 text-sm">
                      <Icon name="chevron" size={13} className="mt-1 text-muted rtl:rotate-180" />
                      {highlight.findingId ? (
                        <a className="link" href={`/findings/${highlight.findingId}`}>
                          {highlight.text[locale]}
                        </a>
                      ) : (
                        <span>{highlight.text[locale]}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Panel>

          <Panel title={t("audit.findings")} icon="shield" flush>
            <div className="panel-body border-b border-line/60">
              <Toolbar className="mb-3">
                <Field label={t("severity.CRITICAL")} htmlFor="filter-severity">
                  <select id="filter-severity" name="severity" className="select" defaultValue={filters.severity ?? "all"}>
                    <option value="all">{t("common.all")}</option>
                    {SEVERITIES.map((severity) => (
                      <option key={severity} value={severity}>
                        {severityLabels[severity]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("category.security")} htmlFor="filter-category">
                  <select id="filter-category" name="category" className="select" defaultValue={filters.category ?? "all"}>
                    <option value="all">{t("common.all")}</option>
                    {CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {categoryLabels[category]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("finding.status")} htmlFor="filter-status">
                  <select id="filter-status" name="status" className="select" defaultValue={filters.status ?? "all"}>
                    <option value="all">{t("common.all")}</option>
                    {Object.entries(statusLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("common.files")} htmlFor="filter-q" wide>
                  <input id="filter-q" name="q" className="input mono" defaultValue={filters.q ?? ""} placeholder="app/Http/Controllers" />
                </Field>
                <button type="submit" className="btn btn-primary">
                  <Icon name="search" size={15} />
                  {t("common.apply")}
                </button>
                {hasFilters ? (
                  <a className="btn btn-ghost" href={`/audits/${jobId}`}>
                    {t("common.reset")}
                  </a>
                ) : null}
              </Toolbar>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                <span>
                  {t("audit.showingResults", {
                    shown: formatNumber(locale, findingItems.length),
                    total: formatNumber(locale, totalCount),
                  })}
                </span>
                <span className="chip">{t("audit.filtersTitle")}</span>
              </div>
            </div>

            {findingItems.length === 0 ? (
              <EmptyState
                title={totalCount === 0 ? t("audit.emptyClean") : t("audit.noFindings")}
                icon={totalCount === 0 ? "check" : "search"}
              />
            ) : (
              <FindingsList
                findings={findingItems}
                locale={locale}
                severityLabels={severityLabels}
                statusLabels={statusLabels}
                categoryLabels={categoryLabels}
                emptyLabel={t("audit.noFindings")}
              />
            )}

          </Panel>

          <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
            <Panel
              title={t("deps.vulnerable")}
              icon="package"
              sub={`${formatNumber(locale, dependencies.length)} ${t("deps.total")} · ${formatNumber(locale, vulnerableDeps.length)} ${t("deps.vulnerable")} · ${formatNumber(locale, outdatedDeps.length)} ${t("deps.outdated")}`}
              action={
                <a className="btn btn-xs btn-ghost" href={`/projects/${project.id}?tab=dependencies`}>
                  {t("common.details")}
                  <Icon name="chevron" size={12} className="rtl:rotate-180" />
                </a>
              }
            >
              {vulnerableDeps.length === 0 ? (
                <Callout tone="ok">
                  {t("deps.source")}: OSV — {t("common.none")}
                </Callout>
              ) : (
                <ul className="rows -m-4 divide-y-0">
                  {vulnerableDeps.slice(0, 5).map((dependency) => (
                    <li key={dependency.id} className="card-tight mx-4 mt-3 first:mt-0">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="mono text-xs">
                          {dependency.packageName}@{dependency.version}
                        </span>
                        <span className="chip">{dependency.ecosystem}</span>
                      </div>
                      <ul className="mt-2 space-y-1 text-xs text-muted">
                        {dependency.vulnerabilities.slice(0, 3).map((vulnerability) => (
                          <li key={vulnerability.advisoryId}>
                            <span className="text-ink">{vulnerability.advisoryId}</span> · {vulnerability.severity}
                            {vulnerability.fixedVersion ? ` · ${t("deps.fixedIn")} ${vulnerability.fixedVersion}` : ""}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title={t("tests.detected")}
              icon="flask"
              sub={executedRun ? t("tests.executed") : t("tests.notRun")}
              flush
            >
              {testRuns.length === 0 ? (
                <div className="panel-body">
                  <p className="text-sm text-muted">{t("tests.none")}</p>
                </div>
              ) : (
                <>
                  {executedRun ? (
                    <TestExecutionDetails testRun={executedRun} t={t} locale={locale} />
                  ) : (
                    <div className="panel-body">
                      <p className="text-sm text-muted">{t("tests.notRequested")}</p>
                    </div>
                  )}
                  {otherRuns.length > 0 ? (
                    <ul className="rows">
                      {otherRuns.map((testRun, index) => (
                        <li key={index} className="row">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium">{testRun.framework}</span>
                              <StatusBadge tone="neutral">{t("audit.notVerified")}</StatusBadge>
                            </div>
                            <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                              {testRun.passed !== null ? (
                                <span>
                                  {t("tests.passed")}: <strong className="text-ink">{testRun.passed}</strong>
                                </span>
                              ) : null}
                              {testRun.failed !== null ? (
                                <span>
                                  {t("tests.failed")}:{" "}
                                  <strong className={testRun.failed > 0 ? "text-critical" : "text-ink"}>{testRun.failed}</strong>
                                </span>
                              ) : null}
                              {testRun.skipped !== null ? (
                                <span>
                                  {t("tests.skipped")}: <strong className="text-ink">{testRun.skipped}</strong>
                                </span>
                              ) : null}
                              {testRun.coveragePercent !== null ? (
                                <span>
                                  {t("tests.coverage")}: <strong className="text-ink">{testRun.coveragePercent}%</strong>
                                </span>
                              ) : null}
                            </p>
                            {testRun.sourceReference ? <p className="row-meta">{testRun.sourceReference}</p> : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
            </Panel>
          </div>

          <div className="grid gap-5 lg:grid-cols-3 lg:items-start">
            <Panel title={t("arch.graph")} icon="layers">
              <KeyValue
                items={[
                  { label: t("arch.nodes"), value: formatNumber(locale, architecture?.nodes ?? 0) },
                  { label: t("arch.edges"), value: formatNumber(locale, architecture?.edges ?? 0) },
                  { label: t("arch.cycles"), value: formatNumber(locale, architecture?.cycles.length ?? 0) },
                  { label: t("arch.coupled"), value: formatNumber(locale, architecture?.highlyCoupled.length ?? 0) },
                ]}
              />
              {architecture && architecture.cycles.length > 0 ? (
                <ul className="mono mt-3 space-y-1 text-xs text-muted">
                  {architecture.cycles.slice(0, 3).map((cycle, index) => (
                    <li key={index} className="truncate">
                      {cycle.path.slice(0, 4).join(" → ")}
                      {cycle.path.length > 4 ? ` (+${cycle.path.length - 4})` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Panel>

            <Panel title={t("engine.quality")} icon="file">
              <KeyValue
                items={[
                  { label: t("quality.functions"), value: formatNumber(locale, quality?.functions ?? 0) },
                  { label: t("quality.avgComplexity"), value: quality ? String(quality.avgComplexity) : "—" },
                  { label: t("quality.maxComplexity"), value: quality ? String(quality.maxComplexity) : "—" },
                  { label: t("quality.duplicateLines"), value: formatNumber(locale, quality?.duplicateLines ?? 0) },
                ]}
              />
            </Panel>

            <Panel title={t("audit.verification")} icon="check">
              <KeyValue
                items={[
                  {
                    label: t("audit.verified"),
                    value: (
                      <StatusBadge tone={stats?.advisoriesVerified ? "ok" : "warn"}>
                        {stats?.advisoriesVerified ? t("audit.verified") : t("audit.notVerified")}
                      </StatusBadge>
                    ),
                  },
                  {
                    label: t("tests.detected"),
                    value: <StatusBadge tone="neutral">{t("audit.notVerified")}</StatusBadge>,
                  },
                  { label: t("finding.aiSource.ai"), value: run?.ai_model ?? t("settings.aiMissing") },
                  {
                    label: t("audit.enginesRun"),
                    value: formatNumber(locale, engines.filter((engine) => engine.status === "ok").length),
                  },
                ]}
              />
            </Panel>
          </div>

          <Panel title={t("audit.enginesRun")} icon="activity" flush>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("audit.stages")}</th>
                    <th>{t("finding.status")}</th>
                    <th>{t("audit.findings")}</th>
                    <th>{t("audit.duration")}</th>
                    <th>{t("audit.evidence")}</th>
                  </tr>
                </thead>
                <tbody>
                  {engines.map((engine) => (
                    <tr key={engine.engine}>
                      <td className="text-sm">{t(`engine.${engine.engine}`)}</td>
                      <td>
                        <StatusBadge tone={engine.status === "ok" ? "ok" : engine.status === "error" ? "bad" : "warn"}>
                          {t(`engine.status.${engine.status}`)}
                        </StatusBadge>
                      </td>
                      <td className="text-sm">{engine.findings}</td>
                      <td className="mono text-xs">{(engine.durationMs / 1000).toFixed(2)}s</td>
                      <td className="text-xs text-muted">
                        {engine.notes.slice(0, 2).join(" · ")}
                        {engine.error ? <span className="text-critical"> {engine.error}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="panel-foot">
              <span className="mono">
                {t("audit.ruleHash")}: {run?.rule_version} · {t("audit.engineVersion")}: {run?.engine_version}
              </span>
            </div>
          </Panel>

          <Panel title={t("audit.limitations")} icon="alert">
            <ul className="space-y-2 text-sm text-muted">
              {(run?.limitations ?? []).map((limitation, index) => (
                <li key={index} className="flex items-start gap-2">
                  <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-medium" />
                  <span>{limitation[locale]}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      ) : null}
    </div>
  );
}
