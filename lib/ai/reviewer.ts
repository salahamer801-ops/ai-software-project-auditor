import type { AiExplanation, BilingualText, Finding, RepoSnapshot, Severity } from "../types";
import { findingEvidenceRefs } from "./evidence-links";
import { aiConfigured, callAiJson, AiError } from "./provider";
import {
  codeContextFor,
  FINDING_EXPLANATION_PROMPT,
  projectContextFor,
  REPORT_SUMMARY_PROMPT,
  type FindingExplanationPayload,
} from "./prompts";

/**
 * The AI reviewer (§28-30).
 *
 * Two hard properties:
 *  1. Every AI result is validated against the analysed manifest: a referenced file that
 *     does not exist is rejected and recorded, never shown as evidence.
 *  2. With no provider configured the same interface is served by a deterministic
 *     rules-engine explanation, clearly labelled as such.
 */

const RULES_PROMPT_VERSION = "rules-v1";

const FALSE_POSITIVE_HINTS: Record<string, BilingualText> = {
  secrets: {
    ar: "إن كانت القيمة تُقرأ من متغير بيئة في وقت التشغيل، أو كانت قيمة اختبار موثّقة، فهي ليست سرًا حقيقيًا.",
    en: "If the value is read from an environment variable at runtime, or is a documented test value, it is not a real secret.",
  },
  security: {
    ar: "إن كان المدخل مقيّدًا بقائمة بيضاء أو يتم تنظيفه قبل هذا الموضع، فقد يكون الأثر محدودًا — تحقّق من المسار الكامل.",
    en: "If the input is allow-listed or sanitised before this point, the impact may be limited — check the full path.",
  },
  dependencies: {
    ar: "إن كانت الحزمة غير مستخدمة في مسار الإنتاج أو مُرقّعة محليًا، فقد لا يكون الأثر عمليًا.",
    en: "If the package is not reachable from a production path, or is patched locally, the practical impact may be low.",
  },
  quality: {
    ar: "الحدود المستخدمة (طول الدالة، التعقيد) تقديرية، وقد تكون مقبولة في سياق هذا الملف تحديدًا.",
    en: "The thresholds used (function length, complexity) are heuristic and may be acceptable in this file's context.",
  },
  architecture: {
    ar: "إن كان الاستيراد ديناميكيًا أو داخل نوع فقط (type-only import)، فقد لا يوجد ارتباط حقيقي في وقت التشغيل.",
    en: "If the import is dynamic or type-only, there may be no real runtime coupling.",
  },
  api: {
    ar: "قد تُفرض المصادقة في وسيط عام (middleware) لا يظهر داخل جسم المعالج — تحقّق من طبقة الوسائط.",
    en: "Authentication may be enforced by global middleware outside the handler body — check the middleware layer.",
  },
  database: {
    ar: "قد يكون الفهرس موجودًا في ترحيل لم يُحلَّل (ترحيل لاحق أو أداة خارجية).",
    en: "The index may exist in a migration that was not analysed (a later migration or an external tool).",
  },
  ops: {
    ar: "إن كانت الصورة الأساسية تُبنى داخليًا مع مستخدم محدود، فقد لا ينطبق التحذير.",
    en: "If the base image is built internally with an unprivileged user, the warning may not apply.",
  },
  tests: {
    ar: "إن كانت الاختبارات تُدار من خارج المستودع (CI منفصل أو منصة خارجية)، فقد توجد تغطية غير ظاهرة هنا.",
    en: "If tests are managed outside the repository (separate CI or external platform), coverage may exist that is not visible here.",
  },
};

const SEVERITY_LABEL: Record<Severity, BilingualText> = {
  CRITICAL: { ar: "حرجة", en: "critical" },
  HIGH: { ar: "عالية", en: "high" },
  MEDIUM: { ar: "متوسطة", en: "medium" },
  LOW: { ar: "منخفضة", en: "low" },
  INFO: { ar: "معلوماتية", en: "informational" },
};

function severityPhrase(severity: Severity, locale: "ar" | "en"): string {
  const label = SEVERITY_LABEL[severity][locale];
  return locale === "ar" ? `شدّة ${label}` : `${label} severity`;
}

/** Deterministic explanation used when no AI provider is configured. */
export function explainFindingWithRules(finding: Finding): AiExplanation {
  const location = finding.filePath
    ? `${finding.filePath}${finding.lineStart ? `:${finding.lineStart}${finding.lineEnd && finding.lineEnd !== finding.lineStart ? `-${finding.lineEnd}` : ""}` : ""}`
    : "the project";
  const occurrences = Number(finding.metadata?.occurrences ?? 1);
  const testPath = finding.filePath ? /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\./i.test(finding.filePath) : false;

  const extraArabic: string[] = [];
  const extraEnglish: string[] = [];
  const advisories = (finding.metadata?.advisories as { id: string; fixedVersion: string | null; severity: string }[] | undefined) ?? [];
  if (advisories.length > 0) {
    const names = advisories.slice(0, 3).map((advisory) => `${advisory.id}${advisory.fixedVersion ? ` (يُصلح في ${advisory.fixedVersion})` : ""}`);
    extraArabic.push(`التحذيرات المطابقة: ${names.join("، ")}.`);
    extraEnglish.push(
      `Matching advisories: ${advisories
        .slice(0, 3)
        .map((advisory) => `${advisory.id}${advisory.fixedVersion ? ` (fixed in ${advisory.fixedVersion})` : ""}`)
        .join(", ")}.`,
    );
  }
  if (finding.category === "quality" && finding.metadata) {
    const lines = finding.metadata.lines as number | undefined;
    const complexity = finding.metadata.complexity as number | undefined;
    if (lines) {
      extraArabic.push(`القياس الفعلي: ${lines} سطرًا.`);
      extraEnglish.push(`Measured value: ${lines} lines.`);
    }
    if (complexity) {
      extraArabic.push(`التعقيد الدورّي المحسوب: ${complexity}.`);
      extraEnglish.push(`Computed cyclomatic complexity: ${complexity}.`);
    }
  }
  if (occurrences > 1) {
    extraArabic.push(`هذه البصمة نفسها ظهرت ${occurrences} مرة داخل هذا التدقيق، والتفاصيل مجمّعة في الأدلة.`);
    extraEnglish.push(`The same fingerprint appears ${occurrences} times in this audit; the details are grouped in the evidence.`);
  }
  if (testPath) {
    extraArabic.push("الموضع داخل مسار اختبار، ما يخفض الأثر العملي غالبًا.");
    extraEnglish.push("The location is inside a test path, which usually lowers the practical impact.");
  }

  const evidenceNoteAr = finding.evidence.length
    ? `الأدلة المسجّلة: ${finding.evidence
        .slice(0, 3)
        .map((item) => item.sourceReference)
        .join("، ")}.`
    : "لا توجد أدلة إضافية مسجّلة.";
  const evidenceNoteEn = finding.evidence.length
    ? `Recorded evidence: ${finding.evidence
        .slice(0, 3)
        .map((item) => item.sourceReference)
        .join(", ")}.`
    : "No additional evidence was recorded.";

  return {
    explanation: {
      ar: `${finding.description.ar} الموضع: ${location}. طريقة الكشف: ${finding.detectionMethod.ar}. ${evidenceNoteAr}${extraArabic.length ? ` ${extraArabic.join(" ")}` : ""}`,
      en: `${finding.description.en} Location: ${location}. Detection method: ${finding.detectionMethod.en}. ${evidenceNoteEn}${extraEnglish.length ? ` ${extraEnglish.join(" ")}` : ""}`,
    },
    practicalImpact: {
      ar: `${finding.impact.ar} (${severityPhrase(finding.severity, "ar")}، ثقة الكشف ${(finding.confidence * 100).toFixed(0)}%).`,
      en: `${finding.impact.en} (${severityPhrase(finding.severity, "en")}, detection confidence ${(finding.confidence * 100).toFixed(0)}%).`,
    },
    remediation: {
      ar: `${finding.recommendation.ar} ابدأ من ${location}، ثم أعد التدقيق للتأكد من اختفاء البصمة نفسها.`,
      en: `${finding.recommendation.en} Start at ${location}, then re-run the audit and confirm the same fingerprint is gone.`,
    },
    falsePositiveIndicators: FALSE_POSITIVE_HINTS[finding.category] ?? {
      ar: "راجع السياق الكامل قبل الاستنتاج.",
      en: "Review the full context before concluding.",
    },
    confidence: finding.confidence,
    evidenceRefs: finding.filePath ? [{ file: finding.filePath, line: finding.lineStart ?? undefined }] : [],
    limitations: [
      "Explanation generated by the rules engine, not by a language model.",
      "No dynamic execution was performed on this project.",
    ],
    verificationOccurred: false,
    rejectedEvidenceRefs: [],
    source: "rules_engine",
    model: null,
    promptVersion: RULES_PROMPT_VERSION,
  };
}

interface RawAiExplanation {
  explanation?: { ar?: string; en?: string };
  practicalImpact?: { ar?: string; en?: string };
  remediation?: { ar?: string; en?: string };
  falsePositiveIndicators?: { ar?: string; en?: string };
  confidence?: number;
  evidenceRefs?: { file?: string; line?: number }[];
  limitations?: string[];
}

function bilingual(input: { ar?: string; en?: string } | undefined, fallback: BilingualText): BilingualText {
  const ar = (input?.ar ?? "").trim();
  const en = (input?.en ?? "").trim();
  return {
    ar: ar || fallback.ar,
    en: en || fallback.en,
  };
}

export interface AiReviewOutcome {
  explanation: AiExplanation;
  error?: string;
}

/** AI explanation with schema + grounding validation. Falls back to rules on any error. */
export async function reviewFinding(
  finding: Finding,
  snapshot: RepoSnapshot,
  fileContents: Map<string, string>,
): Promise<AiReviewOutcome> {
  const fallback = explainFindingWithRules(finding);
  if (!aiConfigured()) return { explanation: fallback };

  const content = finding.filePath ? fileContents.get(finding.filePath) : undefined;
  const payload: FindingExplanationPayload = {
    finding,
    codeContext: codeContextFor(finding, content),
    relatedFiles: snapshot.files.filter((file) => file.text).map((file) => file.path),
    projectContext: projectContextFor(snapshot),
  };

  try {
    const result = await callAiJson<RawAiExplanation>({
      system: `${FINDING_EXPLANATION_PROMPT.system}\n\nOutput contract:\n${FINDING_EXPLANATION_PROMPT.outputContract}`,
      user: FINDING_EXPLANATION_PROMPT.buildUser(payload),
    });

    const raw = result.data ?? {};
    const validation = findingEvidenceRefs(raw.evidenceRefs, snapshot, fileContents, fallback.remediation.ar);
    const limitations = (raw.limitations ?? []).filter((item) => typeof item === "string").slice(0, 6);
    if (validation.rejected.length > 0) {
      limitations.push(
        `${validation.rejected.length} reference(s) returned by the model were rejected because they do not exist in the analysed files.`,
      );
    }

    const explanation: AiExplanation = {
      explanation: bilingual(raw.explanation, fallback.explanation),
      practicalImpact: bilingual(raw.practicalImpact, fallback.practicalImpact),
      remediation: bilingual(raw.remediation, fallback.remediation),
      falsePositiveIndicators: bilingual(raw.falsePositiveIndicators, fallback.falsePositiveIndicators),
      confidence: typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : finding.confidence,
      evidenceRefs: validation.accepted,
      limitations,
      verificationOccurred: validation.accepted.length > 0,
      rejectedEvidenceRefs: validation.rejected,
      source: "ai",
      model: result.model,
      promptVersion: `${FINDING_EXPLANATION_PROMPT.id}@${FINDING_EXPLANATION_PROMPT.version}`,
    };
    return { explanation };
  } catch (error) {
    const message = error instanceof AiError ? error.message : "ai_call_failed";
    return {
      explanation: {
        ...fallback,
        limitations: [...fallback.limitations, `AI provider call failed (${message}); rules-engine explanation used instead.`],
      },
      error: message,
    };
  }
}

export interface AuditAiSummary {
  headline: BilingualText;
  highlights: { findingId: string | null; text: BilingualText }[];
  limitations: string[];
  source: "ai" | "rules_engine";
  model: string | null;
  promptVersion: string;
  usage: { promptTokens: number | null; completionTokens: number | null } | null;
}

/** Audit-level summary: AI when configured, otherwise null (the deterministic summary stays). */
export async function summariseAudit(
  findings: Finding[],
  snapshot: RepoSnapshot,
  engines: string,
  stats: string,
): Promise<AuditAiSummary | null> {
  if (!aiConfigured() || findings.length === 0) return null;
  const counts = findings.reduce<Record<string, number>>((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
    return acc;
  }, {});
  const top = findings.slice(0, 12);
  const topFindings = top
    .map(
      (finding) =>
        `- id=${finding.id} severity=${finding.severity} rule=${finding.ruleId} file=${finding.filePath ?? "n/a"}${
          finding.lineStart ? `:${finding.lineStart}` : ""
        } title(en)=${finding.title.en} // title(ar)=${finding.title.ar}`,
    )
    .join("\n");

  try {
    const result = await callAiJson<{
      headline?: { ar?: string; en?: string };
      highlights?: { findingId?: string; text?: { ar?: string; en?: string } }[];
      limitations?: string[];
    }>({
      system: `${REPORT_SUMMARY_PROMPT.system}\n\nOutput contract:\n${REPORT_SUMMARY_PROMPT.outputContract}`,
      user: REPORT_SUMMARY_PROMPT.buildUser({
        counts,
        topFindings,
        stack: snapshot.stack.frameworks.concat(snapshot.stack.languages.map((lang) => lang.name)).join(", "),
        engines,
        stats,
      }),
      maxTokens: 1100,
    });

    const ids = new Set(findings.map((finding) => finding.id));
    const highlights = (result.data.highlights ?? [])
      .slice(0, 6)
      .map((item) => ({
        findingId: item.findingId && ids.has(item.findingId) ? item.findingId : null,
        text: {
          ar: (item.text?.ar ?? "").trim(),
          en: (item.text?.en ?? "").trim(),
        },
      }))
      .filter((item) => item.text.ar || item.text.en);

    return {
      headline: {
        ar: (result.data.headline?.ar ?? "").trim(),
        en: (result.data.headline?.en ?? "").trim(),
      },
      highlights,
      limitations: (result.data.limitations ?? []).slice(0, 6),
      source: "ai",
      model: result.model,
      promptVersion: `${REPORT_SUMMARY_PROMPT.id}@${REPORT_SUMMARY_PROMPT.version}`,
      usage: result.usage,
    };
  } catch {
    return null;
  }
}
