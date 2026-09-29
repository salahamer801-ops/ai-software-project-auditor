import { requireUser } from "@/lib/auth";
import { getLocale, formatDate } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";
import { aiConfigured, aiModel } from "@/lib/ai/provider";
import { githubTokenConfigured } from "@/lib/sources/github";
import { Breadcrumbs, Callout, KeyValue, Panel, PageHeader, StatusBadge } from "@/components/ui";
import { Icon } from "@/components/icons";
import { DeleteProjectButton } from "@/components/ProjectForms";
import { listProjects } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUser();
  const locale = await getLocale();
  const t = makeT(locale);
  const projects = await listProjects(user.organizationId);

  return (
    <div className="page">
      <PageHeader
        crumb={<Breadcrumbs items={[{ label: t("nav.dashboard"), href: "/dashboard" }, { label: t("nav.settings") }]} />}
        title={t("settings.title")}
        sub={`${user.organizationName} · ${user.role}`}
        actions={
          <a className="btn" href="/privacy">
            <Icon name="shield" size={15} />
            {t("nav.privacy")}
          </a>
        }
      />

      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <Panel title={t("settings.account")} icon="user">
          <KeyValue
            items={[
              { label: t("auth.name"), value: user.name },
              { label: t("auth.email"), value: <span className="mono text-xs">{user.email}</span> },
              { label: t("settings.role"), value: <StatusBadge tone="neutral">{user.role}</StatusBadge> },
              { label: t("dashboard.projects"), value: String(projects.length) },
            ]}
          />
        </Panel>

        <Panel
          title={t("settings.aiProvider")}
          icon="sparkles"
          action={
            <StatusBadge tone={aiConfigured() ? "ok" : "neutral"}>
              {aiConfigured() ? t("settings.aiConfigured") : t("settings.aiMissing")}
            </StatusBadge>
          }
        >
          {aiConfigured() ? <p className="mono mb-3 text-xs text-muted">{aiModel()}</p> : null}
          <Callout tone={aiConfigured() ? "ok" : "info"} icon="sparkles">
            {t("settings.aiMissingHint")}
          </Callout>
          <div className="mt-3 space-y-2 text-sm text-muted">
            <p>
              {locale === "ar"
                ? "للتفعيل: أضف المفتاح باسم AI_API_KEY إلى متغيرات/أسرار المشروع (لا يُكتب في الكود ولا في الواجهة)."
                : "To enable it: add the key as AI_API_KEY in the project's environment secrets (it is never written into code or the UI)."}
            </p>
            <p>
              {locale === "ar"
                ? "أي مزوّد متوافق مع OpenAI يعمل، بما في ذلك الطبقات المجانية: اضبط AI_BASE_URL وAI_MODEL واترك المفتاح في AI_API_KEY."
                : "Any OpenAI-compatible provider works, including free tiers: set AI_BASE_URL and AI_MODEL and keep the key in AI_API_KEY."}
            </p>
          </div>
          <pre className="mono mt-3 overflow-x-auto rounded-lg border border-line bg-canvas/70 p-3 text-xs text-muted">
            AI_API_KEY=…{"\n"}
            AI_BASE_URL=https://…/v1{"\n"}
            AI_MODEL=…
          </pre>
        </Panel>

        <Panel
          title={t("settings.githubToken")}
          icon="globe"
          action={
            <StatusBadge tone={githubTokenConfigured() ? "ok" : "neutral"}>
              {githubTokenConfigured() ? t("settings.githubConfigured") : t("settings.githubMissing")}
            </StatusBadge>
          }
        >
          <p className="text-sm text-muted">{t("project.new.githubHint")}</p>
        </Panel>

        <Panel title={t("settings.retention")} icon="clock">
          <p className="text-sm text-muted">
            {locale === "ar"
              ? "تُحفظ نتائج التدقيقات وملفات الأدلة حتى تحذف المشروع بنفسك — ولا يُحذف أي تدقيق من تلقاء نفسه."
              : "Audit results and evidence stay until you delete the project yourself — no audit is removed automatically."}
          </p>
        </Panel>
      </div>

      <Panel
        title={t("settings.title2")}
        icon="trash"
        sub={t("settings.deleteAccountHint")}
        action={<span className="chip">{projects.length}</span>}
        flush
      >
        {projects.length === 0 ? (
          <div className="panel-body">
            <p className="text-sm text-muted">{t("dashboard.noProjects")}</p>
          </div>
        ) : (
          <ul className="rows">
            {projects.map((project) => (
              <li key={project.id} className="row items-center gap-4">
                <div className="min-w-0 flex-1">
                  <a className="row-title" href={`/projects/${project.id}`}>
                    {project.name}
                  </a>
                  <p className="row-meta">
                    {project.source_type}
                    {project.last_run_at ? ` · ${formatDate(locale, project.last_run_at)}` : ""}
                  </p>
                </div>
                <DeleteProjectButton projectId={project.id} label={t("common.delete")} />
              </li>
            ))}
          </ul>
        )}
        <div className="panel-foot">
          <span className="inline-flex items-center gap-1.5">
            <Icon name="shield" size={13} />
            {t("privacy.deletion")}
          </span>
        </div>
      </Panel>
    </div>
  );
}
