import { query } from "../db";
import { logger } from "../observability/log";
import type { AuditStatus, BilingualText, Severity } from "../types";
import type { ProgressEvent } from "./types";

/** Human labels for every state in §32, bilingual. */
export const STAGE_LABEL: Record<string, BilingualText> = {
  QUEUED: { ar: "في الانتظار", en: "Queued" },
  CLONING: { ar: "جلب المستودع وبناء قائمة الملفات", en: "Fetching the repository and building the manifest" },
  DETECTING: { ar: "كشف التقنيات والإطار", en: "Detecting stack and frameworks" },
  ANALYZING: { ar: "التحليل الساكن", en: "Static analysis" },
  SECURITY_SCAN: { ar: "الأمن وكشف الأسرار", en: "Security and secret detection" },
  DEPENDENCY_SCAN: { ar: "فحص التبعيات مقابل التحذيرات الأمنية", en: "Checking dependencies against advisories" },
  TESTING: { ar: "قراءة نتائج الاختبارات والتغطية المرفوعة", en: "Reading committed test and coverage results" },
  ARCHITECTURE: { ar: "تحليل المعمارية والاعتماديات", en: "Architecture and dependency graph" },
  AI_REVIEW: { ar: "الشرح التفسيري وبناء الملخّص", en: "Explanatory review and summary" },
  VERIFYING: { ar: "التحقق من الأدلة والمراجع", en: "Verifying evidence and references" },
  REPORTING: { ar: "إنشاء التقرير", en: "Generating the report" },
  COMPLETED: { ar: "اكتمل التدقيق", en: "Audit completed" },
  FAILED: { ar: "فشل التدقيق", en: "Audit failed" },
  CANCELLED: { ar: "أُلغي التدقيق", en: "Audit cancelled" },
};

/** Allowed job-state transitions (§32). A stage can never jump; it must follow this graph. */
export const ALLOWED_TRANSITIONS: Record<string, AuditStatus[]> = {
  QUEUED: ["CLONING", "FAILED", "CANCELLED"],
  CLONING: ["DETECTING", "FAILED", "CANCELLED"],
  DETECTING: ["ANALYZING", "FAILED", "CANCELLED"],
  ANALYZING: ["SECURITY_SCAN", "FAILED", "CANCELLED"],
  SECURITY_SCAN: ["DEPENDENCY_SCAN", "FAILED", "CANCELLED"],
  DEPENDENCY_SCAN: ["TESTING", "FAILED", "CANCELLED"],
  TESTING: ["ARCHITECTURE", "FAILED", "CANCELLED"],
  ARCHITECTURE: ["AI_REVIEW", "FAILED", "CANCELLED"],
  AI_REVIEW: ["VERIFYING", "FAILED", "CANCELLED"],
  VERIFYING: ["REPORTING", "FAILED", "CANCELLED"],
  REPORTING: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

/** The happy path, in order — used by tests and diagnostics. */
export const STAGE_SEQUENCE: AuditStatus[] = [
  "QUEUED",
  "CLONING",
  "DETECTING",
  "ANALYZING",
  "SECURITY_SCAN",
  "DEPENDENCY_SCAN",
  "TESTING",
  "ARCHITECTURE",
  "AI_REVIEW",
  "VERIFYING",
  "REPORTING",
  "COMPLETED",
];

export function canTransition(from: AuditStatus, to: AuditStatus): boolean {
  if (from === to) return true;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function severityOrder(severity: Severity): number {
  return ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].indexOf(severity);
}

/**
 * Owns the job state: streams a progress event to the caller, refuses illegal jumps, and
 * writes the stage history to `audit_jobs` so a reload of the page keeps the timeline.
 */
export class StageEmitter {
  private current: AuditStatus = "QUEUED";
  private stages: { stage: AuditStatus; at: string; detail?: string | null }[] = [];
  private readonly jobId: string;
  private readonly onProgress: (event: ProgressEvent) => void;

  constructor(jobId: string, onProgress: (event: ProgressEvent) => void) {
    this.jobId = jobId;
    this.onProgress = onProgress;
  }

  get stage(): AuditStatus {
    return this.current;
  }

  async move(stage: AuditStatus, progress: number, detail?: string | null): Promise<void> {
    if (stage !== this.current) {
      const allowed = ALLOWED_TRANSITIONS[this.current] ?? [];
      if (allowed.length > 0 && !allowed.includes(stage)) {
        // Never let a stage jump happen silently.
        throw new Error(`invalid_transition:${this.current}->${stage}`);
      }
    }
    const startedAt = Date.now();
    this.current = stage;
    this.stages.push({ stage, at: new Date().toISOString(), detail: detail ?? null });
    const event: ProgressEvent = {
      stage,
      progress,
      message: STAGE_LABEL[stage] ?? { ar: stage, en: stage },
      detail: detail ?? null,
      at: new Date().toISOString(),
    };
    logger.info("audit.stage", { jobId: this.jobId, stage, progress, detail: detail ?? null });
    this.onProgress(event);
    await query(
      `update audit_jobs set status = $2, progress = $3, stages = $4::jsonb,
             started_at = coalesce(started_at, now()) where id = $1`,
      [this.jobId, stage, progress, JSON.stringify(this.stages)],
    );
    logger.debug("audit.stage.persisted", { jobId: this.jobId, stage, durationMs: Date.now() - startedAt });
  }

  snapshot(): { stage: AuditStatus; stages: { stage: AuditStatus; at: string; detail?: string | null }[] } {
    return { stage: this.current, stages: this.stages };
  }
}

/** The user can cancel from the UI; every long stage checks this between steps. */
export async function isCancelled(jobId: string): Promise<boolean> {
  const rows = await query<{ status: string }>(`select status from audit_jobs where id = $1`, [jobId]);
  return rows[0]?.status === "CANCELLED";
}
