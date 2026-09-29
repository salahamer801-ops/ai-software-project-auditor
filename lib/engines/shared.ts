import type { RawFinding, RepoFile, RepoSnapshot } from "../types";

export { isUiFile } from "./stack";

export interface EngineContext {
  snapshot: RepoSnapshot;
  emit: (finding: RawFinding) => void;
  note: (message: string) => void;
  /** Absolute ms timestamp after which an engine should stop gracefully. */
  deadline: number;
  /** Text source files only, already sorted by path. */
  files: RepoFile[];
}

export function outOfTime(ctx: EngineContext): boolean {
  return Date.now() > ctx.deadline;
}

export function textFiles(snapshot: RepoSnapshot): RepoFile[] {
  return snapshot.files.filter((file) => file.text && typeof file.content === "string");
}

export interface LineMatch {
  line: number;
  text: string;
  match: RegExpExecArray;
}

/** Runs a regex over the file content and returns the matches with 1-based line numbers. */
export function matchLines(content: string, regex: RegExp, limit = 200): LineMatch[] {
  const results: LineMatch[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.length > 8000) continue;
    const scoped = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
    let match = scoped.exec(line);
    while (match) {
      results.push({ line: index + 1, text: line, match });
      if (results.length >= limit) return results;
      if (match.index === scoped.lastIndex) scoped.lastIndex += 1;
      match = scoped.exec(line);
    }
  }
  return results;
}

/** First matching line number or null (cheap existence check). */
export function findLine(content: string, regex: RegExp): number | null {
  const matches = matchLines(content, regex, 1);
  return matches[0]?.line ?? null;
}

export function snippetAround(content: string, line: number, radius = 3, maxLines = 40): string {
  const lines = content.split("\n");
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(lines.length, line + radius);
  return lines
    .slice(start, end)
    .slice(0, maxLines)
    .map((row) => (row.length > 400 ? `${row.slice(0, 400)}…` : row))
    .join("\n");
}

/** Length-based masking used everywhere a detected value is shown or stored. */
export function maskValue(value: string, keep = 4): string {
  const clean = value.replace(/\s+/g, "");
  if (clean.length <= keep + 2) return "*".repeat(Math.max(clean.length, 4));
  const head = clean.slice(0, Math.min(7, Math.max(3, Math.floor(clean.length * 0.25))));
  const tail = clean.slice(-keep);
  return `${head}${"*".repeat(Math.min(24, clean.length - head.length - tail.length))}${tail}`;
}


/**
 * Second line of defence for secrets: every snippet produced by an engine passes through
 * this scrubber, so a value detected on one line can never reappear in the surrounding
 * context of another finding. The evidence layer scrubs again before storage.
 */
export function scrubSecrets(text: string): string {
  const stars = "*".repeat(8);
  let out = text;

  out = out.replace(/\b((?:sk|rk)_(?:live|test)_)[A-Za-z0-9]{6,}/g, (_match, prefix: string) => `${prefix}${stars}`);
  out = out.replace(/\b(gh[pousr]_)[A-Za-z0-9]{10,}/g, (_match, prefix: string) => `${prefix}${stars}`);
  out = out.replace(/\b(github_pat_)[A-Za-z0-9_]{10,}/g, (_match, prefix: string) => `${prefix}${stars}`);
  out = out.replace(/\b(AKIA)[0-9A-Z]{8,}/g, (_match, prefix: string) => `${prefix}${stars}`);
  out = out.replace(/\b(AIza)[0-9A-Za-z\-_]{10,}/g, (_match, prefix: string) => `${prefix}${stars}`);
  out = out.replace(/\b(SG\.)[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, (_match, prefix: string) => `${prefix}${stars}`);
  out = out.replace(/\b(xox[baprs]-)[A-Za-z0-9-]{6,}/g, (_match, prefix: string) => `${prefix}${stars}`);
  out = out.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, (match) => maskValue(match, 4));
  out = out.replace(
    /([a-z][a-z0-9+.-]*:\/\/[^\s:@'"]+:)[^\s@'"]+(@)/gi,
    (_match, before: string, after: string) => `${before}${stars}${after}`,
  );
  out = out.replace(
    /((?:password|passwd|secret|api[_-]?key|apikey|token|private[_-]?key|jwt[_-]?secret|client[_-]?secret|db[_-]?pass|smtp[_-]?password)\s*[:=]\s*['"`])[^'"`\n]{4,}(['"`])/gi,
    (_match, before: string, after: string) => `${before}${stars}${after}`,
  );
  out = out.replace(
    /^([A-Z][A-Z0-9_]{2,}\s*=\s*)([^\s\n#]{6,})/gm,
    (_match, before: string, value: string) => `${before}${maskValue(value, 4)}`,
  );
  out = out.replace(
    /(-----BEGIN[^\n]*(?:PRIVATE|PGP)[^\n]*-----)([\s\S]*?)(-----END[^\n]*-----)/g,
    (_match, begin: string, _body: string, end: string) => `${begin}\n**** masked ****\n${end}`,
  );

  return out;
}

export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const PLACEHOLDER_PATTERN =
  /(example|placeholder|changeme|change_me|your[-_]?key|dummy|sample|test[-_]?key|xxxxxx|todo|fixme|redacted|fake|<[a-z_-]+>|\$\{|\{\{|process\.env|import\.meta\.env|os\.environ)/i;

export function looksPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value);
}

export function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    /(^|\/)(tests?|__tests__|spec|specs|fixtures?|__mocks__|mock|examples?|docs?|samples?)(\/|$)/.test(lower) ||
    /\.(test|spec)\.[a-z0-9]+$/i.test(lower) ||
    /_test\.(go|py|rb|dart|exs)$/i.test(lower)
  );
}

export function isDocPath(path: string): boolean {
  return /\.(md|mdx|txt|rst|adoc)$/i.test(path) || /(^|\/)docs?(\/|$)/i.test(path);
}

export function makeFinding(input: {
  ruleId: string;
  path: string;
  line?: number | null;
  lineEnd?: number | null;
  snippet?: string;
  symbol?: string;
  confidence?: number;
  severityOverride?: RawFinding["severityOverride"];
  severityReason?: string;
  toolReference?: string;
  metadata?: Record<string, unknown>;
  extraEvidence?: RawFinding["extraEvidence"];
}): RawFinding {
  return {
    ruleId: input.ruleId,
    filePath: input.path,
    lineStart: input.line ?? undefined,
    lineEnd: input.lineEnd ?? input.line ?? undefined,
    snippet: input.snippet ? scrubSecrets(input.snippet) : undefined,
    symbol: input.symbol,
    confidence: input.confidence,
    severityOverride: input.severityOverride,
    severityReason: input.severityReason,
    toolReference: input.toolReference,
    metadata: input.metadata,
    extraEvidence: input.extraEvidence?.map((evidence) => ({
      ...evidence,
      snippet: evidence.snippet ? scrubSecrets(evidence.snippet) : undefined,
    })),
  };
}

export function firstCodeLine(content: string, symbol?: string): number | null {
  if (!symbol) return null;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return findLine(content, new RegExp(`\\b${escaped}\\b`));
}

export function describeLanguage(language: string): string {
  return language === "javascript" || language === "typescript" ? "JS/TS AST" : "text rules";
}
