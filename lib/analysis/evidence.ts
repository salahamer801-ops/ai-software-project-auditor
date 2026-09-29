import { createHash, randomUUID } from "node:crypto";
import { RULES_BY_ID } from "../rules/catalog";
import type { EvidenceInput, Finding, RawFinding, RepoFile, RepoSnapshot, Severity } from "../types";
import { isTestPath, scrubSecrets } from "../engines/shared";

const SEVERITY_RANK: Severity[] = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK.indexOf(severity);
}

function normaliseForHash(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\d+/g, "0")
    .replace(/["'`]/g, "")
    .slice(0, 200);
}

/**
 * Fingerprint (§25): stable across line shifts so the same issue is recognised as the
 * same issue in the next audit, and changes when the code at the site changes.
 */
export function fingerprintFor(input: {
  ruleId: string;
  filePath: string;
  symbol?: string | null;
  anchorText?: string | null;
}): string {
  const anchor = input.symbol
    ? `symbol:${input.symbol}`
    : input.anchorText
      ? `line:${normaliseForHash(input.anchorText)}`
      : "file";
  return createHash("sha256").update(`${input.ruleId}|${input.filePath}|${anchor}`).digest("hex").slice(0, 32);
}

/**
 * Masks anything that looks like a credential inside a snippet we are about to store.
 * The engines scrub as well; this is the last pass before the value reaches the database.
 */
export function maskSnippet(snippet: string | undefined): string | null {
  if (!snippet) return null;
  return scrubSecrets(snippet).slice(0, 2000);
}

export interface NormaliseContext {
  runId: string;
  projectId: string;
  snapshot: RepoSnapshot;
  fileByPath: Map<string, RepoFile>;
}

export interface NormalisedFindings {
  findings: Finding[];
  dropped: number;
  /** Findings that referenced a file outside the analysed manifest — never stored as-is. */
  rejectedReferences: string[];
}

export function normaliseFindings(raw: RawFinding[], context: NormaliseContext): NormalisedFindings {
  const byFingerprint = new Map<string, Finding>();
  const rejectedReferences: string[] = [];
  let dropped = 0;

  for (const item of raw) {
    const rule = RULES_BY_ID[item.ruleId];
    if (!rule) {
      dropped += 1;
      continue;
    }
    const file = context.fileByPath.get(item.filePath);
    if (!file) {
      // Evidence grounding: a finding must point at a file that exists in the analysed
      // manifest, otherwise it is not evidence.
      if (rejectedReferences.length < 20) rejectedReferences.push(`${item.ruleId} → ${item.filePath}`);
      dropped += 1;
      continue;
    }

    const anchorLine = item.lineStart ? (file.content ?? "").split("\n")[item.lineStart - 1] ?? null : null;
    const fingerprint = fingerprintFor({
      ruleId: rule.id,
      filePath: item.filePath,
      symbol: item.symbol ?? null,
      anchorText: anchorLine ?? item.snippet ?? null,
    });

    const severity: Severity = item.severityOverride ?? rule.severity;
    const testPath = isTestPath(item.filePath);
    const confidence = Math.max(
      0.2,
      Math.min(0.99, item.confidence ?? (testPath ? Math.max(0.4, rule.confidence - 0.2) : rule.confidence)),
    );

    const evidence: EvidenceInput[] = [
      {
        sourceType: "code",
        sourceReference: `${item.filePath}${item.lineStart ? `:${item.lineStart}` : ""}`,
        snippet: maskSnippet(item.snippet) ?? undefined,
        metadata: { lineStart: item.lineStart ?? null, lineEnd: item.lineEnd ?? null, symbol: item.symbol ?? null },
      },
      ...(item.extraEvidence ?? []).map((extra) => ({
        ...extra,
        snippet: maskSnippet(extra.snippet) ?? undefined,
      })),
    ];

    const existing = byFingerprint.get(fingerprint);
    if (existing) {
      existing.evidence.push(...evidence);
      existing.metadata.occurrences = Number(existing.metadata.occurrences ?? 1) + 1;
      if (severityRank(severity) > severityRank(existing.severity)) {
        existing.severity = severity;
        existing.severityReason = item.severityReason ?? existing.severityReason;
      }
      continue;
    }

    byFingerprint.set(fingerprint, {
      // Unique per run: the same fingerprint in a later audit is a new row, so history
      // and comparisons stay intact (the fingerprint is what identifies the issue).
      id: `fnd_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      auditRunId: context.runId,
      projectId: context.projectId,
      ruleId: rule.id,
      ruleVersion: rule.version,
      engine: rule.engine,
      category: rule.category,
      severity,
      severitySource: item.severityOverride ? "context" : "rule",
      severityReason: item.severityReason ?? null,
      confidence,
      detectionConfidence: confidence,
      aiConfidence: null,
      title: rule.name,
      description: rule.description,
      impact: rule.impact,
      recommendation: rule.recommendation,
      status: "open",
      statusReason: null,
      filePath: item.filePath,
      lineStart: item.lineStart ?? null,
      lineEnd: item.lineEnd ?? item.lineStart ?? null,
      symbol: item.symbol ?? null,
      evidence,
      detectionMethod: rule.detection,
      toolReference: item.toolReference ?? null,
      fingerprint,
      metadata: { ...(item.metadata ?? {}), occurrences: 1 },
    });
  }

  const findings = Array.from(byFingerprint.values()).sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || (a.filePath ?? "").localeCompare(b.filePath ?? ""),
  );

  return { findings, dropped, rejectedReferences };
}

export function countBySeverity(findings: { severity: Severity }[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const finding of findings) counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  return counts;
}
