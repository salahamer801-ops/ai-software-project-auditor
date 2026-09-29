import type { Finding, RepoSnapshot } from "../types";

/**
 * Versioned prompts (§30). Each prompt has an id, a version, an explicit output contract
 * and a grounding rule: the model may only reference files that exist in the manifest.
 */

export interface PromptDef<TPayload> {
  id: string;
  version: string;
  system: string;
  outputContract: string;
  buildUser: (payload: TPayload) => string;
}

const GROUNDING = `Grounding rules you must follow:
- Only reference files and line numbers that appear in the context you are given.
- Never invent a file, a line, a tool run or a test result.
- If you are unsure, say so in "limitations" instead of guessing.
- Never repeat a full secret value; the value you see is already masked.
- Answer with JSON only.`;

export interface FindingExplanationPayload {
  finding: Finding;
  codeContext: string;
  relatedFiles: string[];
  projectContext: string;
}

export const FINDING_EXPLANATION_PROMPT: PromptDef<FindingExplanationPayload> = {
  id: "finding-explanation",
  version: "v1",
  system: `You are a senior software engineer writing a precise, evidence-bound audit note.
Explain what was detected, why it matters in practice, and how to fix it.
${GROUNDING}`,
  outputContract: `{
  "explanation": { "ar": string, "en": string },
  "practicalImpact": { "ar": string, "en": string },
  "remediation": { "ar": string, "en": string },
  "falsePositiveIndicators": { "ar": string, "en": string },
  "confidence": number,            // 0-1, only about your own reasoning
  "evidenceRefs": [{ "file": string, "line": number }],
  "limitations": string[]          // short, factual
}`,
  buildUser: ({ finding, codeContext, relatedFiles, projectContext }) => `Detected finding
- rule id: ${finding.ruleId} (${finding.ruleVersion})
- rule name (en): ${finding.title.en} / (ar): ${finding.title.ar}
- category: ${finding.category}, severity from rule: ${finding.severity}
- severity source: ${finding.severitySource}${finding.severityReason ? ` (${finding.severityReason})` : ""}
- detection method: ${finding.detectionMethod.en}
- detection confidence (rules engine): ${finding.confidence}
- file: ${finding.filePath}${finding.lineStart ? `:${finding.lineStart}-${finding.lineEnd ?? finding.lineStart}` : ""}
- symbol: ${finding.symbol ?? "n/a"}
- rule description: ${finding.description.en}
- rule impact: ${finding.impact.en}
- rule recommendation: ${finding.recommendation.en}
- tool reference: ${finding.toolReference ?? "n/a"}
- metadata: ${JSON.stringify(finding.metadata).slice(0, 1200)}

Masked evidence snippet:
${(finding.evidence[0]?.snippet ?? finding.title.en).slice(0, 1500)}

Code context (masked, may include nearby lines):
${codeContext}

Project context:
${projectContext}

Related files you may reference (no others exist):
${relatedFiles.slice(0, 25).join("\n")}

Write the JSON object described by the contract. Both "ar" and "en" must be filled.`,
};

export interface SummaryPayload {
  counts: Record<string, number>;
  topFindings: string;
  stack: string;
  engines: string;
  stats: string;
}

export const REPORT_SUMMARY_PROMPT: PromptDef<SummaryPayload> = {
  id: "report-summary",
  version: "v1",
  system: `You summarise a deterministic audit report for a developer. Never add a finding that
is not in the list, never produce a single "score" out of thin air, and never claim the
code is safe. ${GROUNDING}`,
  outputContract: `{
  "headline": { "ar": string, "en": string },
  "highlights": [{ "findingId": string, "text": { "ar": string, "en": string } }],
  "limitations": string[]
}`,
  buildUser: (payload) => `Severity counts: ${payload.counts ? JSON.stringify(payload.counts) : "{}"}

Most severe findings (use their exact ids in "findingId"):
${payload.topFindings}

Detected stack: ${payload.stack}
Engines: ${payload.engines}
Code metrics: ${payload.stats}

Produce at most 6 highlights, ordered by practical risk. Answer with JSON only.`,
};

export const ARCHITECTURE_REVIEW_PROMPT: PromptDef<{ cycles: string[]; coupled: string[]; violations: string[] }> = {
  id: "architecture-review",
  version: "v1",
  system: `You interpret a dependency graph built by a deterministic engine. Do not add edges
or modules that are not listed. ${GROUNDING}`,
  outputContract: `{
  "explanation": { "ar": string, "en": string },
  "practicalImpact": { "ar": string, "en": string },
  "remediation": { "ar": string, "en": string },
  "falsePositiveIndicators": { "ar": string, "en": string },
  "confidence": number,
  "evidenceRefs": [{ "file": string, "line": number }],
  "limitations": string[]
}`,
  buildUser: ({ cycles, coupled, violations }) => `Cycles:
${cycles.slice(0, 10).join("\n") || "none"}

Highly coupled modules:
${coupled.slice(0, 10).join("\n") || "none"}

Layer violations:
${violations.slice(0, 10).join("\n") || "none"}

Explain the architectural consequence and one concrete refactoring, in Arabic and English.`,
};

export function projectContextFor(snapshot: RepoSnapshot): string {
  const stack = snapshot.stack;
  return [
    `source: ${snapshot.source.type} (${snapshot.source.label})`,
    `files analysed: ${snapshot.totals.textFileCount} of ${snapshot.totals.fileCount} (${snapshot.totals.loc} logical lines)`,
    `languages: ${stack.languages.slice(0, 5).map((lang) => `${lang.name}(${lang.files})`).join(", ") || "n/a"}`,
    `frameworks: ${stack.frameworks.join(", ") || "n/a"}`,
    `package managers: ${stack.packageManagers.join(", ") || "n/a"}`,
    `test frameworks: ${stack.testFrameworks.join(", ") || "none detected"}`,
    `docker: ${stack.docker ? "yes" : "no"}; ci: ${stack.ciProviders.join(", ") || "none detected"}`,
  ].join("\n");
}

export function codeContextFor(finding: Finding, content: string | undefined, radius = 12): string {
  if (!content || !finding.lineStart) return "(no code context available)";
  const lines = content.split("\n");
  const start = Math.max(0, finding.lineStart - 1 - radius);
  const end = Math.min(lines.length, finding.lineStart + radius);
  return lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}: ${line.slice(0, 240)}`)
    .join("\n");
}
