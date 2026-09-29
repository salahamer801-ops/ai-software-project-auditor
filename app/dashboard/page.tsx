import { requireUser } from "@/lib/auth";
import { getLocale, formatDate, formatNumber, relativeTime } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";
import {
  Breadcrumbs,
  Callout,
  EmptyState,
  Panel,
  PageHeader,
  SEVERITY_VAR,
  SeverityBadge,
  SeverityBars,
  StatTile,
  StatusBadge,
} from "@/components/ui";
import { Icon } from "@/components/icons";
import { dashboardTotals, listProjects, recentFindings, recentRuns } from "@/lib/queries";

export const dynamic = "force-dynamic";

const ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;

export default async function DashboardPage() {
  const user = await requireUser();
  const locale = await getLocale();
  const t = makeT(locale);

  const [totals, projects, runs, findings] = await Promise.all([
    dashboardTotals(user.organizationId),
    listProjects(user.organizationId),
    recentRuns(user.organizationId, 6),
    recentFindings(user.organizationId, 6),
  ]);

  const severityLabels = {
    CRITICAL: t("severity.CRITICAL"),
    HIGH: t("severity.HIGH"),
    MEDIUM: t("severity.MEDIUM"),
    LOW: t("severity.LOW"),
    INFO: t("severity.INFO"),
  };

  const worst = (counts: Record<string, number> | null) =>
    ORDER.find((severity) => (counts?.[severity] ?? 0) > 0) ?? "INFO";
  const sum = (counts: Record<string, number> | null) =>
    ORDER.reduce((acc, severity) => acc + (counts?.[severity] ?? 0), 0);

  const lastRunDate = projects
    .map((project) => project.last_run_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .pop();

  return (
    <div className="page">
      <PageHeader
        title={t("dashboard.title")}
        sub={t("dashboard.subtitle")}
        meta={<Breadcrumbs items={[{ label: t("dashboard.allProjects") }]} />}
        actions={
          <>
            <a className="btn" href="/about">
              <Icon name="layers" size={15} />
              {t("nav.about")}
            </a>
            <a className="btn btn-primary" href="/projects/new">
              <Icon name="plus" size={15} />
              {t("nav.newProject")}
            </a>
          </>
        }
      />

      <div className="tiles">
        <StatTile label={t("dashboard.projects")} value={formatNumber(locale, totals.projects)} icon="folder" />
        <StatTile label={t("dashboard.totalAudits")} value={formatNumber(locale, totals.runs)} icon="activity" />
        <StatTile
          label={t("dashboard.openFindings")}
          value={formatNumber(locale, totals.openFindings)}
          tone={totals.openFindings > 0 ? "warn" : "ok"}
          icon="alert"
          hint={totals.openFindings > 0 ? t("dashboard.attention") : t("audit.emptyClean")}
        />
        <StatTile
          label={t("project.lastAudit")}
          value={lastRunDate ? relativeTime(locale, lastRunDate) : "—"}
          icon="clock"
          hint={lastRunDate ? formatDate(locale, lastRunDate) : t("dashboard.noAudits")}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.65fr_1fr] lg:items-start">
        <Panel
          title={t("dashboard.projects")}
          icon="folder"
          sub={`${formatNumber(locale, projects.length)} ${t("dashboard.projects")}`}
          flush
        >
          {projects.length === 0 ? (
            <div className="panel-body">
              <EmptyState
                title={t("dashboard.noProjects")}
                body={t("project.new.demoHint")}
                action={
                  <div className="btn-group">
                    <a className="btn btn-primary" href="/projects/new">
                      {t("dashboard.newProjectCta")}
                    </a>
                    <a className="btn" href="/login?demo=1">
                      {t("landing.ctaSecondary")}
                    </a>
                  </div>
                }
              />
            </div>
          ) : (
            <ul className="rows">
              {projects.map((project) => {
                const counts = (project.last_severity_counts ?? {}) as Record<string, number>;
                const total = sum(counts);
                return (
                  <li key={project.id}>
                    <a
                      className="row items-stretch gap-4 hover:bg-surface2/25"
                      href={`/projects/${project.id}`}
                      style={{ ["--sev" as string]: SEVERITY_VAR[worst(counts)] }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="row-title">{project.name}</span>
                          {project.visibility === "private" ? <span className="chip">{t("nav.settings")}</span> : null}
                        </div>
                        <p className="row-meta">
                          {project.repository_url ?? project.source_type}
                          {project.default_branch ? ` · ${project.default_branch}` : ""}
                        </p>
                        <div className="mt-2 max-w-md">
                          {project.last_run_id ? (
                            <SeverityBars counts={counts} labels={severityLabels} total={total} compact />
                          ) : (
                            <StatusBadge tone="neutral">{t("dashboard.noAudits")}</StatusBadge>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-2 text-xs text-muted">
                        <span className="chip">
                          {formatNumber(locale, project.runs)} {t("dashboard.totalAudits")}
                        </span>
                        {project.last_run_at ? <span>{relativeTime(locale, project.last_run_at)}</span> : null}
                        <span className="mt-auto inline-flex items-center gap-1 text-brand">
                          {t("project.lastAudit")}
                          <Icon name="chevron" size={13} className="rtl:rotate-180" />
                        </span>
                      </div>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <div className="flex flex-col gap-5">
          <Panel
            title={t("dashboard.criticalFindings")}
            icon="alert"
            sub={t("dashboard.attention")}
            action={
              <a className="btn btn-xs btn-ghost" href="/projects/new">
                {t("nav.newProject")}
              </a>
            }
            flush
          >
            {findings.length === 0 ? (
              <div className="panel-body">
                <Callout tone="ok">{t("audit.emptyClean")}</Callout>
              </div>
            ) : (
              <ul className="rows">
                {findings.map((finding) => (
                  <li key={finding.id}>
                    <a
                      className="finding"
                      href={`/findings/${finding.id}`}
                      style={{ ["--sev" as string]: SEVERITY_VAR[finding.severity] }}
                    >
                      <div className="min-w-0 flex-1">
                        <span dir="auto" className="block text-sm font-medium">
                          {finding.title[locale]}
                        </span>
                        <p className="row-meta">
                          {finding.project_name} · {finding.file_path}
                          {finding.line_start ? `:${finding.line_start}` : ""}
                        </p>
                      </div>
                      <SeverityBadge severity={finding.severity} label={severityLabels[finding.severity]} />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={t("dashboard.recentAudits")} icon="activity" flush>
            {runs.length === 0 ? (
              <div className="panel-body">
                <p className="text-sm text-muted">{t("dashboard.noAudits")}</p>
              </div>
            ) : (
              <ul className="rows">
                {runs.map((run) => (
                  <li key={run.id}>
                    <a className="row items-center" href={`/audits/${run.id}`}>
                      <div className="min-w-0">
                        <span className="row-title">{run.project_name}</span>
                        <p className="mt-0.5 text-xs text-muted">{formatDate(locale, run.created_at)}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="chip">{formatNumber(locale, Number(run.total_findings))}</span>
                        <StatusBadge tone={run.status === "COMPLETED" ? "ok" : run.status === "FAILED" ? "bad" : "warn"}>
                          {run.status}
                        </StatusBadge>
                      </div>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
