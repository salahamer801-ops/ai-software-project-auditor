import { notFound, redirect } from "next/navigation";
import { getSessionUserSafe } from "@/lib/session";
import { getProjectAccess } from "@/lib/auth";
import {
  getProject,
  getLatestRun,
  listDependencies,
  listFindings,
  listTestRuns,
  projectTrend,
} from "@/lib/queries";
import { recentJobs } from "@/lib/projects";
import { getLocale, formatDate, formatNumber, relativeTime } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";
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
  Tabs,
  Toolbar,
  TrendLine,
} from "@/components/ui";
import { Icon } from "@/components/icons";
import { FindingsList, type FindingListItem } from "@/components/FindingsList";
import { DeleteProjectButton } from "@/components/ProjectForms";
import { RunAuditButton } from "@/components/AuditProgress";

export const dynamic = "force-dynamic";

const TABS = ["overview", "security", "quality", "architecture", "dependencies", "tests", "findings", "history"] as const;
type Tab = (typeof TABS)[number];

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await getSessionUserSafe();
  if (!user) redirect("/login");
  const { id } = await params;
  const access = await getProjectAccess(id, user.id);
  if (!access) notFound();
  const project = await getProject(id);
  if (!project) notFound();

  const { tab: tabParam } = await searchParams;
  const tab: Tab = TABS.includes((tabParam ?? "overview") as Tab) ? ((tabParam ?? "overview") as Tab) : "overview";

  const locale = await getLocale();
  const t = makeT(locale);
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
  const categoryLabels: Record<string, string> = {
    secrets: t("category.secrets"),
    security: t("category.security"),
    dependencies: t("category.dependencies"),
    quality: t("category.quality"),
    architecture: t("category.architecture"),
    api: t("category.api"),
    database: t("category.database"),
    ops: t("category.ops"),
    tests: t("category.tests"),
  };

  const [latest, jobs, trend] = await Promise.all([getLatestRun(id), recentJobs(id, 12), projectTrend(id, 12)]);

  const categoryFilter: Record<Tab, string[]> = {
    overview: [],
    security: ["secrets", "security", "api", "ops"],
    quality: ["quality", "tests"],
    architecture: ["architecture", "database"],
    dependencies: ["dependencies"],
    tests: ["tests"],
    findings: [],
    history: [],
  };

  const allFindings = latest ? await listFindings(latest.id, { limit: 400 }) : [];
  const dependencies = latest ? await listDependencies(latest.id) : [];
  const testRuns = latest ? await listTestRuns(latest.id) : [];

  const toItems = (rows: typeof allFindings): FindingListItem[] =>
    rows.map((finding) => ({
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

  const byTab = (target: Tab) =>
    toItems(
      target === "findings"
        ? allFindings
        : allFindings.filter((finding) => categoryFilter[target].includes(finding.category)),
    );

  const tabFindings = byTab(tab);

  const counts = (latest?.summary?.severityCounts ?? { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 }) as Record<string, number>;
  const total = Object.values(counts).reduce((acc, value) => acc + value, 0);
  const trendPoints = trend.map((run) => ({
    label: formatDate(locale, run.created_at),
    value: Object.entries(run.severity_counts ?? {}).reduce(
      (acc, [severity, value]) =>
        acc + (["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].includes(severity) ? Number(value) : 0),
      0,
    ),
  }));

  const vulnerable = dependencies.filter((item) => (item.vulnerabilities?.length ?? 0) > 0);
  const outdated = dependencies.filter((item) => item.outdated);
  const architecture = latest?.stats?.architecture ?? null;
  const quality = latest?.stats?.quality ?? null;

  const findingsPanel = (title: string, sub: string, items: FindingListItem[]) => (
    <Panel
      title={title}
      icon="shield"
      sub={sub}
      action={
        <span className="chip">
          {formatNumber(locale, items.length)} {t("audit.findings")}
        </span>
      }
      flush
    >
      <FindingsList
        findings={items}
        locale={locale}
        severityLabels={severityLabels}
        statusLabels={statusLabels}
        categoryLabels={categoryLabels}
        emptyLabel={t("audit.noFindings")}
      />
    </Panel>
  );

  const tabs: { href: string; label: string; active: boolean; count?: number }[] = TABS.map((item) => ({
    href: `/projects/${id}?tab=${item}`,
    label: t(`project.tabs.${item}`),
    active: tab === item,
    count: latest && item !== "overview" && item !== "history" ? byTab(item).length : undefined,
  }));

  return (
    <div className="page">
      <PageHeader
        crumb={<Breadcrumbs items={[{ label: t("nav.dashboard"), href: "/dashboard" }, { label: project.name }]} />}
        title={project.name}
        meta={
          <>
            <span className="chip chip-mono">{project.repository_url ?? project.source_type}</span>
            {project.default_branch ? <span className="chip chip-mono">{project.default_branch}</span> : null}
            <span className="chip">{project.visibility}</span>
            {latest ? (
              <StatusBadge tone={latest.status === "COMPLETED" ? "ok" : "warn"}>
                {t("project.lastAudit")} · {relativeTime(locale, latest.created_at)}
              </StatusBadge>
            ) : (
              <StatusBadge tone="neutral">{t("dashboard.noAudits")}</StatusBadge>
            )}
          </>
        }
        actions={
          <>
            <RunAuditButton projectId={project.id} label={t("project.runAudit")} />
            {latest ? (
              <a className="btn" href={`/audits/${latest.audit_job_id}`}>
                <Icon name="report" size={15} />
                {t("audit.summary")}
              </a>
            ) : null}
            {jobs.length >= 2 ? (
              <a className="btn" href={`/compare?a=${jobs[1]!.id}&b=${jobs[0]!.id}`}>
                <Icon name="compare" size={15} />
                {t("project.compare")}
              </a>
            ) : null}
            <DeleteProjectButton projectId={project.id} label={t("common.delete")} />
          </>
        }
      />

      <Tabs items={tabs} label="project tabs" />

      {!latest ? (
        <Panel title={t("project.tabs.overview")} icon="folder">
          <EmptyState
            title={t("project.noAudits")}
            body={t("project.new.demoHint")}
            action={<RunAuditButton projectId={project.id} label={t("project.runAudit")} />}
            icon="activity"
          />
        </Panel>
      ) : null}

      {latest && tab === "overview" ? (
        <>
          <div className="tiles">
            <StatTile
              label={t("dashboard.openFindings")}
              value={formatNumber(locale, total)}
              tone={total > 0 ? "warn" : "ok"}
              icon="alert"
              hint={latest.summary?.status?.replaceAll("_", " ")}
            />
            <StatTile
              label={t("deps.vulnerable")}
              value={formatNumber(locale, vulnerable.length)}
              tone={vulnerable.length > 0 ? "bad" : "ok"}
              icon="package"
              hint={`${formatNumber(locale, dependencies.length)} ${t("deps.total")}`}
            />
            <StatTile label={t("quality.loc")} value={formatNumber(locale, latest.summary?.loc ?? 0)} icon="file" />
            <StatTile
              label={t("arch.cycles")}
              value={formatNumber(locale, architecture?.cycles.length ?? 0)}
              tone={(architecture?.cycles.length ?? 0) > 0 ? "bad" : "ok"}
              icon="layers"
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
            <Panel
              title={t("project.lastAudit")}
              icon="activity"
              sub={formatDate(locale, latest.created_at)}
              action={
                <a className="btn btn-xs btn-ghost" href={`/audits/${latest.audit_job_id}`}>
                  {t("common.details")}
                  <Icon name="chevron" size={12} className="rtl:rotate-180" />
                </a>
              }
            >
              <p className="text-sm leading-relaxed">{latest.summary?.headline[locale]}</p>
              <div className="mt-4">
                <SeverityBars counts={counts} labels={severityLabels} total={total} />
              </div>
              <div className="divider mt-4 pt-4">
                <KeyValue
                  items={[
                    { label: t("audit.commit"), value: <span className="mono text-xs">{latest.commit_sha ?? "—"}</span> },
                    {
                      label: t("audit.duration"),
                      value: `${((latest.duration_ms ?? 0) / 1000).toFixed(1)}${t("common.seconds")}`,
                    },
                    { label: t("audit.ruleHash"), value: <span className="mono text-xs">{latest.rule_version}</span> },
                    { label: t("audit.ai"), value: latest.ai_model ?? t("settings.aiMissing") },
                  ]}
                />
              </div>
            </Panel>

            <Panel title={t("project.stack")} icon="package" sub={t("engine.stack")}>
              <KeyValue
                items={[
                  {
                    label: t("project.stack"),
                    value:
                      latest.stack?.languages
                        .slice(0, 4)
                        .map((lang) => `${lang.name} (${lang.files})`)
                        .join(", ") || "—",
                  },
                  { label: t("landing.featuresTitle"), value: latest.stack?.frameworks.join(", ") || "—" },
                  { label: t("deps.total"), value: latest.stack?.packageManagers.join(", ") || "—" },
                  {
                    label: t("tests.detected"),
                    value: latest.stack?.testFrameworks.join(", ") || t("tests.none"),
                  },
                  { label: t("engine.ops"), value: latest.stack?.ciProviders.join(", ") || t("common.none") },
                  { label: t("deps.source"), value: latest.stack?.databaseIndicators.join(", ") || t("common.none") },
                ]}
              />
            </Panel>
          </div>

          <Panel
            title={t("dashboard.trend")}
            icon="activity"
            sub={
              locale === "ar"
                ? "عدد النتائج في كل تدقيق (آخر ١٢ تدقيق)."
                : "Total findings per audit (last 12 audits)."
            }
          >
            <TrendLine points={trendPoints} label={t("audit.findings")} />
          </Panel>

          {findingsPanel(t("dashboard.criticalFindings"), t("dashboard.attention"), toItems(allFindings.slice(0, 8)))}
        </>
      ) : null}

      {latest && tab === "dependencies" ? (
        <>
          <div className="tiles-3">
            <StatTile label={t("deps.total")} value={formatNumber(locale, dependencies.length)} icon="package" />
            <StatTile
              label={t("deps.vulnerable")}
              value={formatNumber(locale, vulnerable.length)}
              tone={vulnerable.length ? "bad" : "ok"}
              icon="alert"
            />
            <StatTile
              label={t("deps.outdated")}
              value={formatNumber(locale, outdated.length)}
              tone={outdated.length ? "warn" : "ok"}
              icon="clock"
            />
          </div>

          <Panel
            title={t("deps.vulnerable")}
            icon="alert"
            sub={`${t("deps.source")}: OSV (api.osv.dev)`}
            action={<span className="chip">{formatNumber(locale, vulnerable.length)}</span>}
            flush
          >
            {vulnerable.length === 0 ? (
              <div className="panel-body">
                <Callout tone="ok">{t("common.none")}</Callout>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t("deps.package")}</th>
                      <th>{t("deps.scope")}</th>
                      <th>{t("deps.advisory")}</th>
                      <th>{t("deps.fixedIn")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vulnerable.map((dependency) => (
                      <tr key={dependency.id}>
                        <td className="mono text-xs">
                          {dependency.packageName}@{dependency.version}
                          <div className="text-muted">
                            {dependency.ecosystem} · {dependency.manifestPath}
                          </div>
                        </td>
                        <td className="text-xs">
                          {dependency.scope === "direct" ? t("deps.direct") : t("deps.transitive")}
                        </td>
                        <td className="text-xs">
                          {dependency.vulnerabilities.map((vulnerability) => (
                            <div key={vulnerability.advisoryId} className="mb-1 last:mb-0">
                              <span className="mono">{vulnerability.advisoryId}</span> · {vulnerability.severity}
                              {vulnerability.cvss ? ` · CVSS ${vulnerability.cvss}` : ""}
                              <div className="text-muted">{vulnerability.summary}</div>
                            </div>
                          ))}
                        </td>
                        <td className="mono text-xs">
                          {(() => {
                            const fixed = dependency.vulnerabilities
                              .map((vulnerability) => vulnerability.fixedVersion)
                              .filter((version): version is string => Boolean(version));
                            if (fixed.length === 0) return "—";
                            return fixed.length === 1 ? fixed[0] : `${fixed[0]} +${fixed.length - 1}`;
                          })()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {outdated.length > 0 ? (
            <Panel title={t("deps.outdated")} icon="clock" flush>
              <ul className="rows">
                {outdated.slice(0, 24).map((dependency) => (
                  <li key={dependency.id} className="row items-center">
                    <span className="mono text-xs">{dependency.packageName}</span>
                    <span className="mono text-xs text-muted">
                      {dependency.version} → {dependency.latestVersion ?? "?"}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </>
      ) : null}

      {latest && tab === "tests" ? (
        <>
          <Panel title={t("tests.detected")} icon="flask" sub={t("tests.notRun")} flush>
            {testRuns.length === 0 ? (
              <div className="panel-body">
                <p className="text-sm text-muted">{t("tests.none")}</p>
              </div>
            ) : (
              <ul className="rows">
                {testRuns.map((testRun, index) => (
                  <li key={index} className="row">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{testRun.framework}</span>
                        <StatusBadge tone={testRun.executed ? "ok" : "neutral"}>
                          {testRun.executed ? t("audit.verified") : t("audit.notVerified")}
                        </StatusBadge>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                        <span>
                          {t("tests.passed")}: <strong className="text-ink">{testRun.passed ?? "—"}</strong>
                        </span>
                        <span>
                          {t("tests.failed")}: <strong className="text-ink">{testRun.failed ?? "—"}</strong>
                        </span>
                        <span>
                          {t("tests.skipped")}: <strong className="text-ink">{testRun.skipped ?? "—"}</strong>
                        </span>
                        <span>
                          {t("tests.coverage")}:{" "}
                          <strong className="text-ink">
                            {testRun.coveragePercent !== null ? `${testRun.coveragePercent}%` : "—"}
                          </strong>
                        </span>
                      </div>
                      {testRun.sourceReference ? (
                        <p className="row-meta">
                          {t("tests.parsedFrom")}: {testRun.sourceReference}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          {findingsPanel(t("project.tabs.tests"), t("tests.testFiles"), tabFindings)}
        </>
      ) : null}

      {latest && tab === "architecture" ? (
        <>
          <div className="tiles">
            <StatTile label={t("arch.nodes")} value={formatNumber(locale, architecture?.nodes ?? 0)} icon="layers" />
            <StatTile label={t("arch.edges")} value={formatNumber(locale, architecture?.edges ?? 0)} icon="compare" />
            <StatTile
              label={t("arch.cycles")}
              value={formatNumber(locale, architecture?.cycles.length ?? 0)}
              tone={(architecture?.cycles.length ?? 0) > 0 ? "bad" : "ok"}
              icon="refresh"
            />
            <StatTile
              label={t("arch.oversized")}
              value={formatNumber(locale, architecture?.oversizedModules.length ?? 0)}
              icon="file"
            />
          </div>

          <Panel title={t("arch.cycles")} icon="refresh" flush>
            {architecture && architecture.cycles.length > 0 ? (
              <ul className="rows">
                {architecture.cycles.map((cycle, index) => (
                  <li key={index} className="row">
                    <div className="mono flex flex-wrap items-center gap-1.5 text-xs">
                      {cycle.path.map((path, pathIndex) => (
                        <span key={path + pathIndex} className="inline-flex items-center gap-1.5">
                          {pathIndex > 0 ? <Icon name="chevron" size={12} className="text-muted rtl:rotate-180" /> : null}
                          <span className="chip chip-mono">{path}</span>
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="panel-body">
                <Callout tone="ok">{t("common.none")}</Callout>
              </div>
            )}
          </Panel>

          <Panel title={t("arch.coupled")} icon="layers" flush>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("common.files")}</th>
                    <th>fan-in</th>
                    <th>fan-out</th>
                    <th>instability</th>
                  </tr>
                </thead>
                <tbody>
                  {(architecture?.highlyCoupled ?? []).map((node) => (
                    <tr key={node.path}>
                      <td className="mono text-xs">{node.path}</td>
                      <td>{node.fanIn}</td>
                      <td>{node.fanOut}</td>
                      <td>{node.instability}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {findingsPanel(t("project.tabs.architecture"), t("arch.graph"), tabFindings)}
        </>
      ) : null}

      {latest && tab === "quality" ? (
        <>
          <div className="tiles">
            <StatTile label={t("quality.functions")} value={formatNumber(locale, quality?.functions ?? 0)} icon="file" />
            <StatTile label={t("quality.avgComplexity")} value={quality ? String(quality.avgComplexity) : "—"} icon="activity" />
            <StatTile
              label={t("quality.maxComplexity")}
              value={quality ? String(quality.maxComplexity) : "—"}
              tone={(quality?.maxComplexity ?? 0) > 15 ? "warn" : "ok"}
              icon="alert"
            />
            <StatTile
              label={t("quality.duplicateLines")}
              value={formatNumber(locale, quality?.duplicateLines ?? 0)}
              icon="layers"
            />
          </div>
          {findingsPanel(t("project.tabs.quality"), t("engine.quality"), tabFindings)}
        </>
      ) : null}

      {latest && (tab === "security" || tab === "findings") ? (
        <>
          <Callout tone="info" icon="shield">
            {t("finding.maskNote")} · {t("tests.notRun")}
          </Callout>
          {findingsPanel(
            tab === "security" ? t("project.tabs.security") : t("audit.findings"),
            `${t("audit.showingResults", { shown: formatNumber(locale, tabFindings.length), total: formatNumber(locale, total) })}`,
            tabFindings,
          )}
        </>
      ) : null}

      {latest && tab === "history" ? (
        <Panel
          title={t("project.tabs.history")}
          icon="clock"
          sub={
            locale === "ar"
              ? "سجل التدقيقات محفوظ ولا يُحذف — كل تدقيق يبقى للمقارنة."
              : "The audit log is append-only — every audit stays available for comparison."
          }
          flush
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("audit.summary")}</th>
                  <th>{t("finding.status")}</th>
                  <th>{t("audit.findings")}</th>
                  <th>{t("audit.commit")}</th>
                  <th>{t("audit.duration")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td className="text-xs">
                      {formatDate(locale, job.created_at)}
                      <div className="text-muted">{relativeTime(locale, job.created_at)}</div>
                    </td>
                    <td>
                      <StatusBadge tone={job.status === "COMPLETED" ? "ok" : job.status === "FAILED" ? "bad" : "warn"}>
                        {job.status}
                      </StatusBadge>
                    </td>
                    <td className="text-xs">{job.total_findings ?? "—"}</td>
                    <td className="mono text-xs">{(job.commit_sha ?? "—").slice(0, 10)}</td>
                    <td className="mono text-xs">{job.duration_ms ? `${(job.duration_ms / 1000).toFixed(1)}s` : "—"}</td>
                    <td>
                      <a className="link text-xs" href={`/audits/${job.id}`}>
                        {t("common.details")}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {jobs.length >= 2 ? (
            <div className="panel-body">
              <Toolbar action="/compare">
                <Field label={t("compare.base")} htmlFor="compare-a">
                  <select id="compare-a" name="a" className="select" defaultValue={jobs[1]!.id}>
                    {jobs.map((job) => (
                      <option key={job.id} value={job.id}>
                        {formatDate(locale, job.created_at)} — {job.status}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("compare.head")} htmlFor="compare-b">
                  <select id="compare-b" name="b" className="select" defaultValue={jobs[0]!.id}>
                    {jobs.map((job) => (
                      <option key={job.id} value={job.id}>
                        {formatDate(locale, job.created_at)} — {job.status}
                      </option>
                    ))}
                  </select>
                </Field>
                <button type="submit" className="btn btn-primary">
                  <Icon name="compare" size={15} />
                  {t("project.compare")}
                </button>
              </Toolbar>
            </div>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}
