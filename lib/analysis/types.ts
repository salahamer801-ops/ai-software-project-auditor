import type { AuditStatus, BilingualText } from "../types";

/** One stage transition, streamed to the client while the audit runs (§33). */
export interface ProgressEvent {
  stage: AuditStatus;
  progress: number;
  message: BilingualText;
  detail?: string | null;
  at: string;
}

export interface AuditOutcome {
  runId: string | null;
  status: AuditStatus;
  error?: string;
  findings: number;
}
