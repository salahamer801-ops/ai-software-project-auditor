import { notFound, redirect } from "next/navigation";
import { getSessionUserSafe } from "@/lib/session";
import { getProjectAccess } from "@/lib/auth";
import { compareJobs, getJob } from "@/lib/queries";
import { getLocale, formatDate, formatNumber, relativeTime } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";
import {
  Breadcrumbs,
  Panel,
  PageHeader,
  SEVERITY_VAR,
  SeverityBars,
  SeverityBadge,
  StatTile,
  StatusBadge,
} from "@/components/ui";
import { Icon } from "@/components/icons";
import type { ComparisonItem } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; b?: string }>;
}) {
  const user = await getSessionUserSafe();
  if (!user) redirect("/login");
  const { a, b } = await searchParams;
  if (!a || !b) redirect("/dashboard");

  const baseJob = await getJob(a);
  const headJob = await getJob(b);
  if (!baseJob || !headJob || baseJob.project_id !== headJob.project_id) notFound();
  const access = await getProjectAccess(baseJob.project_id, user.id);
  if (!access) notFound();

  const locale = await getLocale();
  const t = makeT(locale);

  const comparison = await compareJobs(a, b);
  if (!comparison) {
    return (
      <div className="page">
        <PageHeader title={t("compare.title")} />
        <Panel title={t("common.error")} icon="alert">
          <p className="text-sm text-muted">{t("common.error")}</p>
          <a className="btn mt-3" href={`/projects/${baseJob.project_id}?tab=history`}>
            {t("project.tabs.history")}
          </a>
        </Panel>
      </div>
    );
  }

  const severityLabels: Record<string, string> = {
    CRITICAL: t("severity.CRITICAL"),
    HIGH: t("severity.HIGH"),
    MEDIUM: t("severity.MEDIUM"),
    LOW: t("severity.LOW"),
    INFO: t("severity.INFO"),
  };

  const totals = (counts: Record<string, number>) =>
    Object.values(counts).reduce((acc, value) => acc + Number(value || 0), 0);

  const sides = [
    { key: "base", title: t("compare.base"), jobId: a, data: comparison.base },
    { key: "head", title: t("compare.head"), jobId: b, data: comparison.head },
  ] as const;

  const Section = ({ title, items, tone }: { title: string; items: ComparisonItem[]; tone: "ok" | "bad" | "neutral" }) => (
    <Panel
      title={title}
      icon={tone === "ok" ? "check" : tone === "bad" ? "alert" : "clock"}
      action={<StatusBadge tone={tone}>{formatNumber(locale, items.length)}</StatusBadge>}
      flush
    >
      {items.length === 0 ? (
        <div className="panel-body">
          <p className="text-sm text-muted">{t("common.none")}</p>
        </div>
      ) : (
        <ul className="rows">
          {items.slice(0, 40).map((item) => (
            <li key={`${item.fingerprint}-${item.findingId}`}>
              <a className="finding" href={`/findings/${item.findingId}`} style={{ ["--sev" as string]: SEVERITY_VAR[item.severity] }}>
                <div className="min-w-0 flex-1">
                  <span dir="auto" className="block text-sm font-medium">
                    {item.title[locale]}
                  </span>
                  <p className="row-meta">
                    {item.ruleId} · {item.filePath}
                    {item.lineStart ? `:${item.lineStart}` : ""}
                  </p>
                </div>
                <SeverityBadge severity={item.severity} label={severityLabels[item.severity]} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );

  return (
    <div className="page">
      <PageHeader
        crumb={
          <Breadcrumbs
            items={[
              { label: t("nav.dashboard"), href: "/dashboard" },
              { label: t("project.tabs.history"), href: `/projects/${baseJob.project_id}?tab=history` },
              { label: t("compare.title") },
            ]}
          />
        }
        title={t("compare.title")}
        sub={t("compare.summary", { count: comparison.resolved.length, newCount: comparison.created.length })}
        actions={
          <a className="btn" href={`/projects/${baseJob.project_id}?tab=history`}>
            <Icon name="clock" size={15} />
            {t("project.tabs.history")}
          </a>
        }
      />

      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        {sides.map((side) => (
          <Panel
            key={side.key}
            title={side.title}
            icon="activity"
            sub={`${formatDate(locale, side.data.createdAt)} · ${relativeTime(locale, side.data.createdAt)}`}
            action={
              <a className="btn btn-xs btn-ghost" href={`/audits/${side.jobId}`}>
                {t("common.details")}
                <Icon name="chevron" size={12} className="rtl:rotate-180" />
              </a>
            }
          >
            <SeverityBars counts={side.data.counts} labels={severityLabels} total={totals(side.data.counts)} />
          </Panel>
        ))}
      </div>

      <div className="tiles">
        <StatTile label={t("compare.resolved")} value={formatNumber(locale, comparison.resolved.length)} tone="ok" icon="check" />
        <StatTile label={t("compare.new")} value={formatNumber(locale, comparison.created.length)} tone="bad" icon="alert" />
        <StatTile label={t("compare.unchanged")} value={formatNumber(locale, comparison.unchanged.length)} icon="clock" />
        <StatTile label={t("compare.reopened")} value={formatNumber(locale, comparison.reopened.length)} tone="warn" icon="refresh" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <Section title={t("compare.resolved")} items={comparison.resolved} tone="ok" />
        <Section title={t("compare.new")} items={comparison.created} tone="bad" />
        <Section title={t("compare.unchanged")} items={comparison.unchanged} tone="neutral" />
        <Section title={t("compare.reopened")} items={comparison.reopened} tone="neutral" />
      </div>
    </div>
  );
}
