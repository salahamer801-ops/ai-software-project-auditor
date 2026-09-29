import { requireUser } from "@/lib/auth";
import { getLocale } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";
import { NewProjectForm } from "@/components/ProjectForms";
import { Breadcrumbs, Callout, Panel, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function NewProjectPage() {
  await requireUser();
  const locale = await getLocale();
  const t = makeT(locale);

  return (
    <div className="page">
      <PageHeader
        crumb={<Breadcrumbs items={[{ label: t("nav.dashboard"), href: "/dashboard" }, { label: t("nav.newProject") }]} />}
        title={t("project.new.title")}
        sub={t("project.new.githubHint")}
      />

      <div className="grid gap-5 lg:grid-cols-[1.7fr_1fr] lg:items-start">
        <Panel title={t("project.new.source")} icon="package" sub={`${t("project.new.github")} · ${t("project.new.upload")} · ${t("project.new.demo")}`}>
          <NewProjectForm />
        </Panel>

        <div className="flex flex-col gap-5">
          <Panel title={t("landing.guaranteeTitle")} icon="shield" flush>
            <ul className="rows">
              {["landing.guarantee1", "landing.guarantee2", "landing.guarantee3", "landing.guarantee4"].map((key) => (
                <li key={key} className="row items-start gap-2">
                  <Icon name="check" size={15} className="mt-0.5 text-brand" />
                  <span className="text-sm text-muted">{t(key)}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title={t("landing.pipelineTitle")} icon="activity" flush>
            <ol className="rows">
              {[
                { ar: "المستودع أو الأرشيف", en: "Repository or archive" },
                { ar: "تحليل حتمي بمحركات", en: "Deterministic engines" },
                { ar: "طبقة الأدلة والبصمة", en: "Evidence and fingerprint layer" },
                { ar: "مراجعة AI تفسيرية", en: "Explanatory AI review" },
                { ar: "تقرير ومقارنة", en: "Report and comparison" },
              ].map((step, index) => (
                <li key={step.en} className="row items-center gap-3">
                  <span className="mono grid h-6 w-6 shrink-0 place-items-center rounded-md bg-brand/10 text-xs text-brand">
                    {index + 1}
                  </span>
                  <span className="text-sm">{step[locale]}</span>
                </li>
              ))}
            </ol>
          </Panel>

          <Callout tone="info" icon="clock">
            {t("project.new.uploadHint")}
          </Callout>
        </div>
      </div>
    </div>
  );
}
