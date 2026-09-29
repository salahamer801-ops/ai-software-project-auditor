import { cookies } from "next/headers";
import { ensureSchema, query } from "@/lib/db";
import { getLocale, formatNumber } from "@/lib/i18n/server";
import { t } from "@/lib/i18n/dict";
import { RULE_CATALOG } from "@/lib/rules/catalog";
import { APP_NAME, ENGINE_VERSION, RULE_CATALOG_VERSION } from "@/lib/types";
import { Callout, Chip, Panel, StatTile } from "@/components/ui";
import { Icon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const locale = await getLocale();
  const tt = (key: string, vars?: Record<string, string | number>) => t(locale, key, vars);

  // Live catalog numbers come from the rule registry, not from marketing text.
  let ruleCount = RULE_CATALOG.length;
  let auditsRun: number | null = null;
  try {
    await ensureSchema();
    const rows = await query<{ total: string }>(`select count(*)::text as total from audit_runs`);
    auditsRun = Number(rows[0]?.total ?? "0");
  } catch {
    auditsRun = null;
  }

  const pipeline = [
    { ar: "المستودع أو الأرشيف", en: "Repository or archive", icon: "package" },
    { ar: "تحليل حتمي بمحركات", en: "Deterministic engines", icon: "activity" },
    { ar: "طبقة الأدلة والبصمة", en: "Evidence and fingerprint layer", icon: "file" },
    { ar: "مراجعة AI تفسيرية", en: "Explanatory AI review", icon: "sparkles" },
    { ar: "تحقق من المراجع", en: "Reference verification", icon: "check" },
    { ar: "تقرير ومقارنة", en: "Report and comparison", icon: "report" },
  ];

  const checks = [
    { ar: "أسرار ومفاتيح مكشوفة", en: "Exposed secrets and keys" },
    { ar: "ثغرات التبعيات (OSV)", en: "Dependency vulnerabilities (OSV)" },
    { ar: "حقن SQL والأوامر وXSS", en: "SQL/command injection and XSS" },
    { ar: "ضعف المصادقة والتصريح", en: "Weak authentication and authorisation" },
    { ar: "تعقيد وتكرار الكود", en: "Complexity and code duplication" },
    { ar: "اعتماديات دائرية وخرق طبقات", en: "Circular dependencies and layer violations" },
    { ar: "واجهات API ومدخلات غير محقّقة", en: "API routes and unvalidated input" },
    { ar: "قواعد البيانات والفهارس وأنماط N+1", en: "Databases, indexes and N+1 patterns" },
    { ar: "Docker وCI وأسرار خطوط النشر", en: "Docker, CI and pipeline secrets" },
    { ar: "نقص الاختبارات والتغطية", en: "Missing tests and coverage" },
  ];

  const cookiesStore = await cookies();
  const hasSession = !!cookiesStore.get("apx_session")?.value;

  return (
    <div className="flex flex-col gap-6">
      <section className="grid gap-5 lg:grid-cols-[1.15fr_1fr] lg:items-start">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Chip mono brand>
              {APP_NAME} v{ENGINE_VERSION}
            </Chip>
            <Chip mono>rules {RULE_CATALOG_VERSION}</Chip>
          </div>
          <h1 className="text-2xl font-bold leading-tight sm:text-3xl">{tt("landing.heroTitle")}</h1>
          <p className="text-sm leading-relaxed text-muted sm:text-base">{tt("landing.heroBody")}</p>
          <div className="btn-group">
            <a className="btn btn-primary btn-lg" href={hasSession ? "/projects/new" : "/register"}>
              <Icon name="activity" size={16} />
              {tt("landing.ctaPrimary")}
            </a>
            <a className="btn btn-lg" href="/login?demo=1">
              <Icon name="sparkles" size={16} />
              {tt("landing.ctaSecondary")}
            </a>
          </div>
          <div className="tiles-3 mt-1">
            <StatTile label={tt("about.rules")} value={formatNumber(locale, ruleCount)} tone="ok" icon="shield" />
            <StatTile
              label={tt("dashboard.totalAudits")}
              value={auditsRun === null ? "—" : formatNumber(locale, auditsRun)}
              icon="activity"
            />
            <StatTile label={tt("audit.engineVersion")} value={`v${ENGINE_VERSION}`} icon="layers" />
          </div>
        </div>

        <Panel title={tt("landing.pipelineTitle")} icon="activity" flush>
          <ol className="rows">
            {pipeline.map((step, index) => (
              <li key={step.en} className="row items-center gap-3">
                <span className="mono grid h-6 w-6 shrink-0 place-items-center rounded-md bg-brand/10 text-xs text-brand">
                  {index + 1}
                </span>
                <Icon name={step.icon} size={15} className="text-muted" />
                <span className="text-sm">{step[locale]}</span>
              </li>
            ))}
          </ol>
          <div className="panel-foot">
            <span className="inline-flex items-center gap-1.5">
              <Icon name="shield" size={13} />
              {locale === "ar" ? "محركات حتمية قبل الذكاء الاصطناعي" : "Deterministic engines before AI"}
            </span>
          </div>
        </Panel>
      </section>

      <section className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <Panel title={tt("landing.featuresTitle")} icon="shield" sub={tt("landing.stackTitle")} flush>
          <ul className="rows">
            {checks.map((item) => (
              <li key={item.en} className="row items-center gap-2.5 py-2.5">
                <Icon name="check" size={14} className="text-brand" />
                <span className="text-sm text-muted">{item[locale]}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <div className="flex flex-col gap-5">
          <Panel title={tt("landing.guaranteeTitle")} icon="shield">
            <ul className="space-y-2">
              {["landing.guarantee1", "landing.guarantee2", "landing.guarantee3", "landing.guarantee4"].map((key) => (
                <li key={key}>
                  <Callout tone="info" icon="check">
                    {tt(key)}
                  </Callout>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title={tt("landing.stackTitle")} icon="file">
            <div className="tiles-3">
              <div className="card-tight">
                <div className="text-xs text-muted">{tt("category.security")}</div>
                <div className="text-sm">
                  <span className="font-semibold text-critical">1</span> Critical ·{" "}
                  <span className="font-semibold text-high">6</span> High
                </div>
              </div>
              <div className="card-tight">
                <div className="text-xs text-muted">{tt("category.architecture")}</div>
                <div className="text-sm">2 {tt("arch.cycles")}</div>
              </div>
              <div className="card-tight">
                <div className="text-xs text-muted">{tt("tests.coverage")}</div>
                <div className="text-sm">54%</div>
              </div>
            </div>
            <div className="mt-3">
              <a className="btn btn-soft" href="/about">
                <Icon name="layers" size={15} />
                {tt("nav.about")}
              </a>
            </div>
          </Panel>
        </div>
      </section>
    </div>
  );
}
