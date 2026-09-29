// Domain types shared by the engines, the API layer and the UI.
// Everything here is plain data so it can be serialised into PostgreSQL jsonb.

export type Locale = "ar" | "en";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export const SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

export type FindingCategory =
  | "secrets"
  | "security"
  | "dependencies"
  | "quality"
  | "architecture"
  | "api"
  | "database"
  | "ops"
  | "tests";

export const CATEGORIES: FindingCategory[] = [
  "secrets",
  "security",
  "dependencies",
  "quality",
  "architecture",
  "api",
  "database",
  "ops",
  "tests",
];

export type FindingStatus = "open" | "confirmed" | "false_positive" | "ignored" | "fixed";

export type EngineId =
  | "stack"
  | "secrets"
  | "security"
  | "dependencies"
  | "quality"
  | "architecture"
  | "api"
  | "database"
  | "ops"
  | "tests";

export const ENGINES: EngineId[] = [
  "stack",
  "secrets",
  "security",
  "dependencies",
  "quality",
  "architecture",
  "api",
  "database",
  "ops",
  "tests",
];

export type AuditStatus =
  | "QUEUED"
  | "CLONING"
  | "DETECTING"
  | "ANALYZING"
  | "SECURITY_SCAN"
  | "DEPENDENCY_SCAN"
  | "TESTING"
  | "ARCHITECTURE"
  | "AI_REVIEW"
  | "VERIFYING"
  | "REPORTING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface BilingualText {
  ar: string;
  en: string;
}

export interface RuleDef {
  id: string;
  name: BilingualText;
  category: FindingCategory;
  engine: EngineId;
  severity: Severity;
  confidence: number;
  languages: string[] | "all";
  /** Human description of how the rule detects the issue (shown as "detection method"). */
  detection: BilingualText;
  description: BilingualText;
  impact: BilingualText;
  recommendation: BilingualText;
  references: string[];
  version: string;
}

/** What an engine emits. The evidence layer normalises it into a Finder. */
export interface RawFinding {
  ruleId: string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  symbol?: string;
  /** Masked snippet shown as evidence (never a raw secret). */
  snippet?: string;
  severityOverride?: Severity;
  severityReason?: string;
  confidence?: number;
  toolReference?: string;
  metadata?: Record<string, unknown>;
  extraEvidence?: EvidenceInput[];
}

export interface EvidenceInput {
  sourceType: "code" | "tool_output" | "test_result" | "manifest" | "ai_verification" | "external_advisory";
  sourceReference: string;
  snippet?: string;
  metadata?: Record<string, unknown>;
}

export interface Finding {
  id: string;
  auditRunId: string;
  projectId: string;
  ruleId: string;
  ruleVersion: string;
  engine: EngineId;
  category: FindingCategory;
  severity: Severity;
  severitySource: "rule" | "context" | "ai_suggested";
  severityReason: string | null;
  confidence: number;
  detectionConfidence: number;
  aiConfidence: number | null;
  title: BilingualText;
  description: BilingualText;
  impact: BilingualText;
  recommendation: BilingualText;
  status: FindingStatus;
  statusReason: string | null;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  symbol: string | null;
  evidence: EvidenceInput[];
  detectionMethod: BilingualText;
  toolReference: string | null;
  fingerprint: string;
  metadata: Record<string, unknown>;
  aiExplanation?: AiExplanation | null;
}

export interface AiExplanation {
  explanation: BilingualText;
  practicalImpact: BilingualText;
  remediation: BilingualText;
  falsePositiveIndicators: BilingualText;
  confidence: number;
  evidenceRefs: { file: string; line?: number }[];
  limitations: string[];
  verificationOccurred: boolean;
  rejectedEvidenceRefs: { file: string; line?: number; reason: string }[];
  source: "ai" | "rules_engine";
  model: string | null;
  promptVersion: string;
}

export interface EngineRunInfo {
  engine: EngineId;
  status: "ok" | "skipped" | "error";
  durationMs: number;
  findings: number;
  notes: string[];
  error?: string;
}

export interface LanguageStat {
  name: string;
  files: number;
  loc: number;
}

export interface StackInfo {
  languages: LanguageStat[];
  frameworks: string[];
  packageManagers: string[];
  testFrameworks: string[];
  buildTools: string[];
  ciProviders: string[];
  databaseIndicators: string[];
  manifests: string[];
  docker: boolean;
  apiSurface: string[];
  totalFiles: number;
  totalLoc: number;
}

export interface RepoFile {
  path: string;
  size: number;
  text: boolean;
  language: string;
  lines: number;
  loc: number;
  /** Present only for text files that fit within the analysis budget. */
  content?: string;
}

export interface RepoSnapshot {
  files: RepoFile[];
  stack: StackInfo;
  totals: {
    fileCount: number;
    textFileCount: number;
    bytes: number;
    loc: number;
    binarySkipped: number;
    oversizedSkipped: number;
    ignoredPaths: number;
    truncated: boolean;
  };
  source: {
    type: "github" | "upload" | "demo";
    label: string;
    repositoryUrl?: string;
    owner?: string;
    repo?: string;
    ref?: string;
    commitSha?: string;
    bytes?: number;
  };
  limits: {
    maxFiles: number;
    maxFileSize: number;
    maxTotalTextBytes: number;
    maxTimeMs: number;
  };
}

export interface DependencyRecord {
  packageManager: string;
  packageName: string;
  version: string;
  ecosystem: string;
  scope: "direct" | "transitive";
  manifestPath: string;
  latestVersion?: string | null;
  outdated?: boolean | null;
  vulnerabilities?: VulnerabilityRecord[];
}

export interface VulnerabilityRecord {
  advisoryId: string;
  severity: Severity;
  cvss: number | null;
  summary: string;
  description: string;
  fixedVersion: string | null;
  source: string;
  publishedAt: string | null;
  references: string[];
}

export interface TestRunRecord {
  framework: string;
  command: string | null;
  status: "detected" | "parsed" | "not_run";
  executed: boolean;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  coveragePercent: number | null;
  durationMs: number | null;
  outputExcerpt: string | null;
  sourceReference: string | null;
}

export interface QualityMetrics {
  totalLoc: number;
  files: number;
  avgFunctionLength: number;
  maxFunctionLength: number;
  avgComplexity: number;
  maxComplexity: number;
  duplicateBlocks: number;
  duplicateLines: number;
  functions: number;
  filesOverThreshold: number;
  todoComments: number;
  longParameterFunctions: number;
  emptyCatchBlocks: number;
  deepNesting: number;
}

export interface ArchitectureSummary {
  nodes: number;
  edges: number;
  cycles: { path: string[]; length: number }[];
  highlyCoupled: { path: string; fanIn: number; fanOut: number; instability: number }[];
  layerViolations: { from: string; to: string; rule: string }[];
  oversizedModules: { path: string; loc: number }[];
  graph: { source: string; target: string }[];
}

export interface AuditSummary {
  status: "CLEAN" | "ATTENTION_REQUIRED" | "ACTION_REQUIRED" | "CRITICAL";
  severityCounts: Record<Severity, number>;
  categoryCounts: Record<string, number>;
  categorySeverity: Record<string, Record<Severity, number>>;
  totalFindings: number;
  filesAnalyzed: number;
  loc: number;
  stackHighlights: string[];
  headline: BilingualText;
  highlights: { findingId: string | null; text: BilingualText }[];
}

export const ENGINE_VERSION = "1.0.0";
export const RULE_CATALOG_VERSION = "1.0.0";
export const ANALYSIS_LIMITS = {
  maxFiles: 4000,
  maxFileSize: 400_000,
  maxTotalTextBytes: 12_000_000,
  maxAnalyzableFilesPerEngine: 2500,
  maxTimeMs: 55_000,
};
export const APP_NAME = "CodeAudit";
