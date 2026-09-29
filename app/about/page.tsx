import { getLocale } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";
import { Breadcrumbs, KeyValue, Panel, PageHeader, StatusBadge } from "@/components/ui";
import { Icon } from "@/components/icons";
import { SelfTestPanel } from "@/components/Actions";
import { RULE_CATALOG, ruleStats } from "@/lib/rules/catalog";
import { aiConfigured } from "@/lib/ai/provider";
import { ENGINE_VERSION, RULE_CATALOG_VERSION, type Locale } from "@/lib/types";

export const dynamic = "force-dynamic";

const PIPELINE = [
  ["المستودع أو الأرشيف", "Repository or archive"],
  ["تحليل حتمي بمحركات", "Deterministic engines"],
  ["طبقة الأدلة والبصمة", "Evidence and fingerprint layer"],
  ["مراجعة AI تفسيرية (اختيارية)", "Explanatory AI review (optional)"],
  ["تحقق من المراجع", "Reference verification"],
  ["تقرير ومقارنة", "Report and comparison"],
];

const LIMITATIONS: [string, string][] = [
  [
    "لا يُنفَّذ أي كود من المشروع: لا تثبيت حزم، ولا تشغيل اختبارات، ولا بناء صور — تحليل ساكن فقط.",
    "No project code is executed: no dependency install, no test run, no image build — static analysis only.",
  ],
  [
    "نتائج الاختبار والتغطية تُقرأ من ملفات نتيجتها المرفوعة مع المشروع (JUnit XML، coverage-summary.json، lcov.info) ولا تُشغَّل هنا.",
    "Test and coverage numbers are read from result files committed with the project (JUnit XML, coverage-summary.json, lcov.info); nothing runs here.",
  ],
  [
    "لا مراجعة Pull Request ولا تحديث تلقائي للتبعيات ولا إصلاح تلقائي للكود في V1 (خارطة الطريق).",
    "No pull-request review, automatic dependency updates or automatic code fixes in V1 (roadmap).",
  ],
  [
    "لا اختبار اختراق ولا طلبات على أنظمة خارجية: كل الفحص على الشيفرة والملفات.",
    "No penetration testing and no requests to external systems: everything is read from the code and its files.",
  ],
];

export default async function AboutPage() {
  const locale = await getLocale();
  const t = makeT(locale);
  const stats = ruleStats();

  return (
    <div className="page">
      <PageHeader
        crumb={<Breadcrumbs items={[{ label: t("nav.dashboard"), href: "/dashboard" }, { label: t("nav.about") }]} />}
        title={t("about.title")}
        sub={t("app.tagline")}
        meta={
          <>
            <span className="chip chip-mono">engine {ENGINE_VERSION}</span>
            <span className="chip chip-mono">rules {RULE_CATALOG_VERSION}</span>
            <span className="chip">{stats.total} {t("about.rules")}</span>
          </>
        }
      />

      <Panel title={t("about.pipelineTitle")} icon="activity" flush>
        <ol className="rows">
          {PIPELINE.map(([ar, en], index) => (
            <li key={en} className="row items-center gap-3">
              <span className="mono grid h-6 w-6 shrink-0 place-items-center rounded-md bg-brand/10 text-xs text-brand">
                {index + 1}
              </span>
              <span className="text-sm">{locale === "ar" ? ar : en}</span>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel title={t("about.enginesTitle")} icon="layers" flush>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("audit.stages")}</th>
                <th>{t("audit.findings")}</th>
                <th>{t("audit.evidence")}</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["stack", "طريقة كشف", "Manifests, lock files and CI files — never the folder name alone", "الملفات والتعريفات، وليس اسم المجلد"],
                ["secrets", "أنماط + Entropy", "Patterns + entropy, values masked before storage", "أنماط معروفة مع قياس العشوائية، والقيم مُخفاة قبل التخزين"],
                ["security", "قواعد ساكنة", "Language-aware static rules (AST for JS/TS)", "قواعد لكل لغة مع AST لـJS/TS"],
                ["dependencies", "OSV", "OSV advisories with fixed versions", "تحذيرات OSV مع إصدار الإصلاح"],
                ["quality", "AST + مقاييس", "TypeScript AST metrics, duplication windows", "مقاييس AST ونوافذ كشف التكرار"],
                ["architecture", "رسم اعتماديات", "Import graph, cycles, coupling, layer checks", "رسم الاستيرادات والحلقات والارتباط"],
                ["api", "قراءة المسارات", "Route and handler inspection, no live requests", "قراءة المسارات والمعالجات بلا طلبات فعلية"],
                ["database", "مخططات وترحيلات", "SQL/Prisma/Django/Laravel schema parsing", "تحليل ملفات المخططات والترحيلات"],
                ["ops", "ملفات الحاويات وCI", "Dockerfile, compose and pipeline files", "Dockerfile وdocker-compose وملفات CI"],
                ["tests", "ملفات النتائج", "Framework detection + committed JUnit/coverage", "كشف الإطار وقراءة ملفات النتائج المرفوعة"],
              ].map(([engine, method, en, ar]) => (
                <tr key={engine}>
                  <td className="text-sm">{t(`engine.${engine}`)}</td>
                  <td className="text-xs text-muted">{method}</td>
                  <td className="text-xs text-muted">{locale === "ar" ? ar : en}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title={t("about.evidenceTitle")} icon="file">
        <ul className="space-y-2 text-sm text-muted">
          <li>
            {locale === "ar"
              ? "كل نتيجة مرتبطة بقاعدة محددة، وملف وسطر، ودليل مقتبس (مُخفى القيم الحساسة)."
              : "Every finding is tied to one rule, a file and line, and an evidence snippet (sensitive values masked)."}
          </li>
          <li>
            {locale === "ar"
              ? "لكل نتيجة بصمة ثابتة (Fingerprint): تُستخدم لمقارنة التدقيقات ومنع ظهور المشكلة نفسها كمشكلة جديدة."
              : "Each finding carries a stable fingerprint, used to compare audits so the same issue is never reported as new."}
          </li>
          <li>
            {locale === "ar"
              ? "قرارات المستخدم (إيجابية كاذبة، تجاهل، مُصلَحة) تُحفظ بالبصمة وتُطبَّق في التدقيقات القادمة، دون حذف أي شيء من التاريخ."
              : "User decisions (false positive, ignored, fixed) are stored by fingerprint and re-applied in later audits, with nothing deleted from history."}
          </li>
          <li>
            {locale === "ar"
              ? "الشدّة تأتي من القاعدة أو من سياق التحذير الأمني، وأي تعديل يُحفظ مع سببه ومصدره."
              : "Severity comes from the rule or from the advisory context, and any override is stored with its reason and source."}
          </li>
        </ul>
      </Panel>

      <Panel
        title={t("about.aiTitle")}
        icon="sparkles"
        action={
          <StatusBadge tone={aiConfigured() ? "ok" : "neutral"}>
            {aiConfigured() ? t("settings.aiConfigured") : t("settings.aiMissing")}
          </StatusBadge>
        }
      >
        <ul className="space-y-2 text-sm text-muted">
          <li>
            {locale === "ar"
              ? "AI لا يقرر وجود المشكلة: وجودها يأتي من محركات حتمية، وAI يشرح ويقترح الإصلاح فقط."
              : "AI does not decide whether an issue exists: the deterministic engines do that, and AI explains and suggests fixes."}
          </li>
          <li>
            {locale === "ar"
              ? "كل مخرجات AI JSON مُهيكل، ويُفحص ضد مخطط، وكل مرجع ملف/سطر يُتحقق منه مقابل ملفات المشروع وإلا يُرفض ويُسجَّل الرفض."
              : "All AI output is structured JSON, validated against a contract, and every file/line reference is verified against the analysed files — rejected references are recorded."}
          </li>
          <li>
            {locale === "ar"
              ? "ممنوع برمجيًا: اختراع ملفات أو ثغرات، ادعاء تشغيل اختبار، ادعاء إصلاح بلا Patch، كشف أسرار، أو إعطاء تقييم عام بلا دليل."
              : "Enforced in code: no invented files or vulnerabilities, no claims of running tests, no fix without a patch, no secret disclosure, no score without evidence."}
          </li>
          <li>
            {locale === "ar"
              ? "بدون مفتاح مزوّد يعمل كل شيء، ويُستبدل شرح AI بشرح من محرّك القواعد مُعلَّم بوضوح."
              : "With no provider key everything still works; AI explanations are replaced by clearly labelled rules-engine explanations."}
          </li>
        </ul>
      </Panel>

      <Panel title={t("about.safetyTitle")} icon="shield">
        <ul className="space-y-2 text-sm text-muted">
          <li>
            {locale === "ar"
              ? "المستودع يُعامل كمُدخل غير موثوق: يُقرأ كنص، ولا يُنفَّذ، ولا يستدعي أي تثبيت حزم أو سكربت."
              : "The repository is treated as untrusted input: read as data, never executed, never triggering installs or scripts."}
          </li>
          <li>
            {locale === "ar"
              ? "الاستخراج مقيّد: حدود لعدد الملفات والحجم، حذف الأدلة الثنائية، ورفض أي مسار يحتوي على .. أو مسار مطلق."
              : "Extraction is bounded: file-count and size caps, binary and vendor folders skipped, and any path containing .. or an absolute path is rejected."}
          </li>
          <li>
            {locale === "ar"
              ? "الأسرار لا تُخزَّن كاملة: القيم تُخفى في الأدلة والتقارير وفي قاعدة البيانات."
              : "Secrets are never stored in full: values are masked in evidence, reports and the database."}
          </li>
        </ul>
      </Panel>

      <Panel title={t("about.limitsTitle")} icon="alert">
        <ul className="space-y-2 text-sm text-muted">
          {LIMITATIONS.map(([ar, en], index) => (
            <li key={index} className="flex items-start gap-2">
              <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-medium" />
              <span>{locale === "ar" ? ar : en}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title={t("about.rulesCatalog")} icon="layers">
        <KeyValue
          items={[
            { label: t("about.rules"), value: `${stats.total} — v${stats.version}` },
            { label: t("audit.engineVersion"), value: ENGINE_VERSION },
            { label: t("audit.ruleHash"), value: RULE_CATALOG_VERSION },
            {
              label: t("audit.findings"),
              value: Object.entries(stats.byCategory)
                .map(([category, count]) => `${t(`category.${category}`)}: ${count}`)
                .join(" · "),
            },
          ]}
        />
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-brand">
            {locale === "ar" ? "عرض كل القواعد" : "Show every rule"}
          </summary>
          <ul className="mt-3 space-y-2">
            {RULE_CATALOG.map((rule) => (
              <li key={rule.id} className="rounded-lg border border-line/60 bg-surface2/20 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm">{rule.name[locale as Locale]}</span>
                  <span className="flex items-center gap-2 text-xs">
                    <span className="chip chip-mono">{rule.id}</span>
                    <StatusBadge
                      tone={
                        rule.severity === "CRITICAL" || rule.severity === "HIGH"
                          ? "bad"
                          : rule.severity === "MEDIUM"
                            ? "warn"
                            : "neutral"
                      }
                    >
                      {t(`severity.${rule.severity}`)}
                    </StatusBadge>
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted">{rule.description[locale as Locale]}</p>
                <p className="mt-1 text-xs text-muted">
                  {t("finding.detection")}: {rule.detection[locale as Locale]}
                </p>
              </li>
            ))}
          </ul>
        </details>
      </Panel>

      <Panel
        title={t("about.diagnostics")}
        icon="flask"
        sub={
          locale === "ar"
            ? "اختبارات حقيقية تُشغَّل الآن على محركات الكشف نفسها باستخدام مستودع العرض المُفخّخ عمدًا: كشف الأسرار، إخفاء القيم، استقرار البصمة، رسم الاعتماديات، والمزيد."
            : "Real tests executed right now against the same detection engines, using the intentionally flawed demo fixture: secret detection, masking, fingerprint stability, dependency graph and more."
        }
      >
        <SelfTestPanel />
      </Panel>
    </div>
  );
}
