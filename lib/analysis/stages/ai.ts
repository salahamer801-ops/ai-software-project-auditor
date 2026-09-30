import { newId } from "../../db";
import { logger } from "../../observability/log";
import { aiConfigured, aiModel } from "../../ai/provider";
import { reviewFinding, summariseAudit, type AuditAiSummary } from "../../ai/reviewer";
import type { AiExplanation, EngineRunInfo, Finding, RepoSnapshot } from "../../types";
import type { AuditState } from "./engines";

export interface AiReviewRecord {
  id: string;
  findingId: string;
  explanation: AiExplanation;
  model: string | null;
  promptVersion: string;
  usage: { promptTokens: number | null; completionTokens: number | null } | null;
}

export interface AiStageInput {
  findings: Finding[];
  snapshot: RepoSnapshot;
  engines: EngineRunInfo[];
  state: AuditState;
  deadline: number;
}

export interface AiStageResult {
  reviews: AiReviewRecord[];
  rejections: number;
  summary: AuditAiSummary | null;
}

/**
 * Stage 11 (§14): the explanatory layer, on top of findings that already have evidence.
 *
 * Only the most severe findings are reviewed, the model gets minimal context (§39) and every
 * reference it returns is verified against the analysed manifest before it is stored (§29).
 * Without a provider key the same interface is served by the rules engine and labelled as such.
 */
export async function runAiStage(input: AiStageInput): Promise<AiStageResult> {
  const { findings, snapshot, engines, state, deadline } = input;
  const startedAt = Date.now();
  const fileContents = new Map(snapshot.files.filter((file) => file.text).map((file) => [file.path, file.content ?? ""]));
  const reviewBudget = Number(process.env.AI_MAX_FINDINGS ?? "8");
  const reviewTargets = findings
    .filter((finding) => finding.severity === "CRITICAL" || finding.severity === "HIGH" || finding.severity === "MEDIUM")
    .slice(0, Math.max(1, Math.min(reviewBudget, 12)));

  logger.info("audit.ai.started", {
    provider: aiConfigured() ? "external" : "rules_engine",
    model: aiConfigured() ? aiModel() : null,
    candidates: reviewTargets.length,
    budget: reviewBudget,
  });

  let rejections = 0;
  const reviews: AiReviewRecord[] = [];

  for (const finding of reviewTargets) {
    if (Date.now() > deadline + 20_000) {
      logger.warn("audit.ai.budget_exhausted", { jobFindings: findings.length, reviewed: reviews.length });
      break;
    }
    const { explanation } = await reviewFinding(finding, snapshot, fileContents);
    finding.aiConfidence = explanation.confidence;
    rejections += explanation.rejectedEvidenceRefs.length;
    reviews.push({
      id: newId("air"),
      findingId: finding.id,
      explanation,
      model: explanation.model,
      promptVersion: explanation.promptVersion,
      usage: null,
    });
  }

  const summary = await summariseAudit(
    findings,
    snapshot,
    engines.map((engine) => `${engine.engine}:${engine.status}`).join(", "),
    state.quality ? JSON.stringify(state.quality) : "{}",
  );

  if (summary) rejections += summary.limitations.length;

  logger.info("audit.ai.completed", {
    source: summary?.source ?? "rules_engine",
    reviewed: reviews.length,
    rejectedReferences: rejections,
    durationMs: Date.now() - startedAt,
  });

  return { reviews, rejections, summary };
}
