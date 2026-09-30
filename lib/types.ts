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

/** Case-level result of an executed test run (§23). Names and messages are masked before storage. */
export interface SandboxCase {
  name: string;
  /** Repository-relative path of the test file, as it exists in the audited project. */
  file: string;
  line: number | null;
  ok: boolean;
  skipped: boolean;
  durationMs: number | null;
  message: string | null;
}

/** Exactly what an executed run was allowed to do, recorded with the result (§24, §34). */
export interface SandboxInfo {
  mode: string;
  limits: {
    wallMs: number;
    perFileMs: number;
    memoryMb: number;
    maxFiles: number;
    maxOutputBytes: number;
  };
  /** Test files that were actually executed. */
  files: string[];
  /** Files that looked runnable but were skipped, with a stable reason code. */
  skipped: { path: string; reason: string }[];
  /** Suites that could not even be loaded (syntax error, missing file). */
  crashed: { path: string; error: string }[];
  environment: { env: "scrubbed"; network: "guarded"; filesystem: "read-only"; processes: "denied" };
  truncated: boolean;
}

export interface TestRunRecord {
  framework: string;
  command: string | null;
  status: "detected" | "parsed" | "not_run" | "executed";
  executed: boolean;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  coveragePercent: number | null;
  durationMs: number | null;
  outputExcerpt: string | null;
  sourceReference: string | null;
  /** Set when the run came from the execution sandbox; null for committed artifacts. */
  mode?: string | null;
  /** Case-level results, bounded and masked. */
  cases?: SandboxCase[];
  /** The limits the run executed under. */
  sandbox?: SandboxInfo | null;
  /** True when the case list or the output was cut at the analysis limits. */
  truncated?: boolean;
}

/**
 * What the execution phase actually did, carried into the report's limitations and the UI.
 * `notes` are shown verbatim, which is why they read like sentences rather than log fields.
 */
export interface ExecutionSummary {
  requested: boolean;
  executed: boolean;
  status: "disabled" | "no-candidates" | "busy" | "executed" | "timeout" | "error";
  mode: string;
  files: number;
  skipped: number;
  crashed: number;
  limits: SandboxInfo["limits"];
  notes: string[];
}

/** Options chosen when an audit job is queued (persisted on the job row). */
export interface AuditJobOptions {
  /**
   * Run the project's self-contained Node test files in the restricted execution sandbox.
   * Off by default: it is the only feature that ever runs audited code.
   */
  runTests?: boolean;
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

export const ENGINE_VERSION = "1.2.0";
export const RULE_CATALOG_VERSION = "1.2.0";
export const ANALYSIS_LIMITS = {
  maxFiles: 4000,
  maxFileSize: 400_000,
  maxTotalTextBytes: 12_000_000,
  maxAnalyzableFilesPerEngine: 2500,
  maxTimeMs: 55_000,
  /**
   * Limits for the execution sandbox (§24). Everything here is enforced, not advisory: the
   * wall clock and per-file limits kill the child process with SIGKILL, the memory cap is a
   * real V8 heap limit, and the file caps bound what is copied into the workspace.
   */
  sandbox: {
    wallMs: 20_000,
    perFileMs: 8_000,
    memoryMb: 176,
    maxFiles: 12,
    maxOutputBytes: 24_000,
    maxWorkspaceBytes: 20_000_000,
  },
};
export const APP_NAME = "CodeAudit";
