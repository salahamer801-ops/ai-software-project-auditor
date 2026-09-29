import { getLocale } from "@/lib/i18n/server";
import { makeT } from "@/lib/i18n/dict";
import { Breadcrumbs, Panel, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function PrivacyPage() {
  const locale = await getLocale();
  const t = makeT(locale);

  const sections: { title: string; body: string }[] =
    locale === "ar"
      ? [
          {
            title: t("privacy.what"),
            body:
              "يُحلَّل محتوى المشروع نصيًا: ملفات الشيفرة، ملفات الحزم والقفل، ملفات CI والحاويات، ملفات الترحيلات، وملفات نتائج الاختبار والتغطية إن وُجدت. لا يُنفَّذ أي شيء من المشروع، ولا تُثبَّت حزم، ولا تُشغَّل اختبارات على خوادمنا.",
          },
          {
            title: t("privacy.where"),
            body:
              "النتائج والأدلة والتقارير تُخزَّن في قاعدة بيانات المشروع على Mythex، وكل صف مرتبط بحسابك. الملفات المرفوعة (ZIP/tar.gz) تُخزَّن مع المشروع لإعادة التدقيق، وتُحذف مع حذف المشروع.",
          },
          {
            title: t("privacy.ai"),
            body:
              "عند تفعيل مزوّد AI يُرسل سياق أدنى فقط لكل نتيجة: تعريف القاعدة، مقتطف الكود المحيط (مُخفى القيم الحساسة)، وبيانات المشروع العامة — ولا يُرسل المستودع كاملًا. بدون مفتاح مزوّد لا يُرسل أي شيء لأي طرف خارجي.",
          },
          {
            title: t("privacy.retention"),
            body:
              "نتائج التدقيق وسجلّها تبقى ما دام المشروع موجودًا ودون حذف تلقائي، حتى تستطيع مقارنة التدقيقات ومعرفة هل أُصلحت المشكلة. قراراتك (إيجابية كاذبة/تجاهل) مرتبطة ببصمة المشكلة وتُطبَّق في التدقيقات القادمة.",
          },
          {
            title: t("privacy.deletion"),
            body:
              "من صفحة الإعدادات أو من صفحة المشروع: حذف المشروع يحذف كل ما يخصه — التدقيقات، النتائج، الأدلة، التبعيات، مراجعات AI، والتقارير — بلا رجعة.",
          },
          {
            title: t("settings.account"),
            body:
              "كلمات المرور تُخزَّن بصيغة scrypt مع ملح لكل مستخدم. الجلسات في قاعدة البيانات وتُلغى عند الخروج. تُسجَّل محاولات الدخول الفاشلة لتحديد المعدل، ولا تُسجَّل أي بيانات حساسة في السجلات.",
          },
          {
            title: t("nav.privacy"),
            body:
              "الأسرار المكتشفة تُخفى دائمًا قبل التخزين (مثال: sk_live_****************1234)، ولا يُحفظ السر كاملًا في قاعدة البيانات أو التقارير.",
          },
        ]
      : [
          {
            title: t("privacy.what"),
            body:
              "The project is analysed as text: source files, package and lock files, CI and container files, migrations, and committed test/coverage result files if present. Nothing from the project is executed, no dependency is installed and no test runs on our servers.",
          },
          {
            title: t("privacy.where"),
            body:
              "Results, evidence and reports are stored in the project's database on Mythex, and every row belongs to your account. Uploaded archives (ZIP/tar.gz) are stored with the project so it can be re-audited, and are removed when the project is deleted.",
          },
          {
            title: t("privacy.ai"),
            body:
              "When an AI provider is enabled, only minimal context per finding is sent: the rule definition, the surrounding code snippet (sensitive values masked) and general project facts — never the whole repository. With no provider key configured, nothing is sent anywhere.",
          },
          {
            title: t("privacy.retention"),
            body:
              "Audit results and their history stay as long as the project exists, with no automatic deletion, so you can compare audits and see whether an issue was fixed. Your decisions (false positive/ignore) are tied to the finding fingerprint and re-applied in later audits.",
          },
          {
            title: t("privacy.deletion"),
            body:
              "From the settings page or the project page: deleting a project deletes everything it owns — audits, findings, evidence, dependencies, AI reviews and reports — permanently.",
          },
          {
            title: t("settings.account"),
            body:
              "Passwords are stored with scrypt and a per-user salt. Sessions live in the database and are revoked on logout. Failed login attempts are recorded for rate limiting, and no sensitive values are written to logs.",
          },
          {
            title: t("nav.privacy"),
            body:
              "Detected secrets are always masked before storage (for example sk_live_****************1234), and the full value is never kept in the database or in reports.",
          },
        ];

  return (
    <div className="page">
      <PageHeader
        crumb={<Breadcrumbs items={[{ label: t("nav.dashboard"), href: "/dashboard" }, { label: t("nav.privacy") }]} />}
        title={t("privacy.title")}
        sub={t("app.tagline")}
      />
      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        {sections.map((section) => (
          <Panel key={section.title} title={section.title} icon="shield">
            <p className="text-sm leading-relaxed text-muted">{section.body}</p>
          </Panel>
        ))}
      </div>
    </div>
  );
}
