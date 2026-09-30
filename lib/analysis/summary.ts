import type {
  AuditSummary,
  BilingualText,
  EngineRunInfo,
  ExecutionSummary,
  Finding,
  RepoSnapshot,
  Severity,
} from "../types";
import { countBySeverity, severityRank } from "./evidence";
import { stackHighlights } from "../engines/stack";

export interface SummaryInput {
  findings: Finding[];
  snapshot: RepoSnapshot;
  engines: EngineRunInfo[];
  aiHeadline?: BilingualText | null;
  aiHighlights?: { findingId: string | null; text: BilingualText }[] | null;
}

export function verdictFor(findings: Finding[]): AuditSummary["status"] {
  const counts = countBySeverity(findings);
  if (counts.CRITICAL > 0) return "CRITICAL";
  if (counts.HIGH > 0) return "ACTION_REQUIRED";
  if (counts.MEDIUM + counts.LOW > 0) return "ATTENTION_REQUIRED";
  return "CLEAN";
}

export function buildAuditSummary(input: SummaryInput): AuditSummary {
  const counts = countBySeverity(input.findings);
  const categoryCounts: Record<string, number> = {};
  const categorySeverity: Record<string, Record<Severity, number>> = {};

  for (const finding of input.findings) {
    categoryCounts[finding.category] = (categoryCounts[finding.category] ?? 0) + 1;
    const bucket = categorySeverity[finding.category] ?? { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
    bucket[finding.severity] += 1;
    categorySeverity[finding.category] = bucket;
  }

  const status = verdictFor(input.findings);
  const severityText = (severity: Severity, locale: "ar" | "en") => {
    const map: Record<Severity, [string, string]> = {
      CRITICAL: ["حرجة", "critical"],
      HIGH: ["عالية", "high"],
      MEDIUM: ["متوسطة", "medium"],
      LOW: ["منخفضة", "low"],
      INFO: ["معلوماتية", "informational"],
    };
    return map[severity][locale === "ar" ? 0 : 1];
  };

  const headline: BilingualText = input.aiHeadline ?? {
    ar:
      status === "CLEAN"
        ? "لم تُكتشف مشكلات في هذا التدقيق."
        : `تم اكتشاف ${counts.CRITICAL + counts.HIGH + counts.MEDIUM + counts.LOW + counts.INFO} نتيجة: ${counts.CRITICAL} حرجة و${counts.HIGH} عالية و${counts.MEDIUM} متوسطة.`,
    en:
      status === "CLEAN"
        ? "No issues were detected in this audit."
        : `${counts.CRITICAL + counts.HIGH + counts.MEDIUM + counts.LOW + counts.INFO} findings: ${counts.CRITICAL} critical, ${counts.HIGH} high, ${counts.MEDIUM} medium.`,
  };

  const top = [...input.findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity)).slice(0, 6);
  const highlights =
    input.aiHighlights && input.aiHighlights.length > 0
      ? input.aiHighlights
      : top.map((finding) => ({
          findingId: finding.id,
          text: {
            ar: `${severityText(finding.severity, "ar")}: ${finding.title.ar} — ${finding.filePath ?? ""}${
              finding.lineStart ? `:${finding.lineStart}` : ""
            }`,
            en: `${severityText(finding.severity, "en")}: ${finding.title.en} — ${finding.filePath ?? ""}${
              finding.lineStart ? `:${finding.lineStart}` : ""
            }`,
          },
        }));

  return {
    status,
    severityCounts: counts,
    categoryCounts,
    categorySeverity,
    totalFindings: input.findings.length,
    filesAnalyzed: input.snapshot.totals.textFileCount,
    loc: input.snapshot.totals.loc,
    stackHighlights: stackHighlights(input.snapshot.stack),
    headline,
    highlights,
  };
}

export function buildLimitations(input: {
  snapshot: RepoSnapshot;
  engines: EngineRunInfo[];
  advisoriesVerified: boolean;
  testsExecuted: boolean;
  /**
   * What the execution phase asked for and did (§24). Absent means "no execution information",
   * which reads as the plain static-analysis limitation.
   */
  execution?: ExecutionSummary | null;
  aiEnabled: boolean;
  rejectedEvidenceRefs: number;
  truncated: boolean;
}): BilingualText[] {
  const execution = input.execution;
  const limitations: BilingualText[] = [];
  if (input.testsExecuted && execution) {
    const limits = execution.limits;
    limitations.push(
      {
        ar: `شُغِّلت اختبارات Node فعليًا في ${execution.files} ملف داخل عملية معزولة: لا كتابة على القرص، ولا عمليات فرعية، وبيئة منظّفة بلا أي أسرار، وواجهات الشبكة محجوبة، وبحدود ${limits.perFileMs} مللي/ملف و${limits.memoryMb} ميجابايت من الذاكرة.`,
        en: `Node tests really ran, in ${execution.files} file(s), inside a restricted child process: no disk writes, no child processes, a scrubbed environment with no secrets, outbound network entry points denied, and limits of ${limits.perFileMs} ms/file and ${limits.memoryMb} MB of memory.`,
      },
      {
        ar: "هذا ليس حاوية: العزل داخل العملية نفسها ويُفرض بنموذج صلاحيات Node وحُرّاس على واجهات الشبكة، لذا لا يُعدّ عزلاً على مستوى نظام التشغيل ولا يُغني عن CI معزول.",
        en: "This is not a container: isolation happens inside the same process, enforced by Node's permission model and network guards, so it is not operating-system-level isolation and does not replace isolated CI.",
      },
    );
  } else {
    limitations.push({
      ar: "لا يُنفَّذ أي كود من المشروع: لا تثبيت حزم، ولا تشغيل اختبارات، ولا بناء صور.",
      en: "No project code is executed: no dependency install, no test run, no image build.",
    });
  }
  if (execution?.requested && !input.testsExecuted) {
    const reason =
      execution.status === "busy"
        ? {
            ar: "كان تنفيذ آخر يعمل على نفس الخادم، فأُجّل التنفيذ لهذا التدقيق.",
            en: "Another execution was already running on this host, so this audit did not run tests.",
          }
        : execution.status === "no-candidates"
          ? {
              ar: `طُلب تشغيل الاختبارات لكن لا يوجد ملف اختبار مكتفٍ بذاته (يستورد node:test فقط وبلا حزم خارجية): ${execution.skipped} ملف مرشّح رُفض، وأسباب الرفض مذكورة في لوحة الاختبارات.`,
              en: `Tests were requested, but no self-contained file qualifies (it must import node:test and need no outside packages): ${execution.skipped} candidate file(s) were rejected, each with its reason on the tests panel.`,
            }
          : {
              ar: "طُلب تشغيل الاختبارات لكن التنفيذ لم يكتمل على هذا الخادم، والنتائج أدناه من التحليل الساكن.",
              en: "Tests were requested, but execution did not complete on this host; the results below come from static analysis.",
            };
    limitations.push(reason);
  }
  limitations.push(
    {
      ar: "التحليل ساكن: المشكلات التي تظهر وقت التشغيل فقط (تزامن، أداء فعلي، سلوك بيئة الإنتاج) لا يمكن تأكيدها هنا.",
      en: "The analysis is static: runtime-only problems (races, real performance, production environment behaviour) cannot be confirmed here.",
    },
  );
  if (!input.testsExecuted) {
    limitations.push({
      ar: "نتائج الاختبار والتغطية مأخوذة من ملفات نتيجتها المرفوعة مع المشروع إن وُجدت، وإلا فهي غير معروفة — ولم يُشغَّل أي اختبار على خوادمنا.",
      en: "Test and coverage numbers come from result files committed with the project when present; otherwise they are unknown — no test was executed on our servers.",
    });
  }
  if (!input.advisoriesVerified) {
    limitations.push({
      ar: "لم يتم الاتصال بقاعدة التحذيرات الأمنية في هذا التشغيل، لذا لم يتم التحقق من ثغرات التبعيات.",
      en: "The advisory database could not be reached during this run, so dependency vulnerabilities were not verified.",
    });
  }
  if (!input.aiEnabled) {
    limitations.push({
      ar: "شرح AI غير مُفعَّل: الشروح أدناه مبنية على محرّك القواعد وبيانات الأدلة فقط.",
      en: "AI explanation is not enabled: the explanations below come from the rules engine and the evidence data only.",
    });
  }
  const skipped = input.engines.filter((engine) => engine.status !== "ok");
  if (skipped.length > 0) {
    limitations.push({
      ar: `محركات لم تكمل العمل: ${skipped.map((engine) => engine.engine).join(", ")}.`,
      en: `Engines that did not complete: ${skipped.map((engine) => engine.engine).join(", ")}.`,
    });
  }
  if (input.truncated) {
    limitations.push({
      ar: "تم اقتصاص المشروع عند حدود التحليل (عدد ملفات أو حجم)، لذا قد تكون أجزاء لم تُفحص.",
      en: "The project was truncated at the analysis limits (file count or size), so parts may not have been scanned.",
    });
  }
  if (input.rejectedEvidenceRefs > 0) {
    limitations.push({
      ar: `${input.rejectedEvidenceRefs} مرجع أدلة رُفض لأنه لا يطابق ملفات المشروع المُحلَّلة.`,
      en: `${input.rejectedEvidenceRefs} evidence references were rejected because they do not match the analysed files.`,
    });
  }
  return limitations;
}
