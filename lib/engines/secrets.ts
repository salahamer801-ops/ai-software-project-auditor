import type { RawFinding } from "../types";
import type { EngineContext } from "./shared";
import { isDocPath, isTestPath, looksPlaceholder, makeFinding, maskValue, matchLines, shannonEntropy, snippetAround } from "./shared";

/**
 * Secret detection (§17). Two hard rules:
 *  - a detected value is masked before it is ever stored or shown;
 *  - the full secret never reaches the database.
 */

interface Pattern {
  ruleId: string;
  regex: RegExp;
  confidence: number;
  label: string;
  /** Value captured for masking (defaults to the whole match). */
  valueGroup?: number;
}

const PROVIDER_PATTERNS: Pattern[] = [
  { ruleId: "SEC-001", regex: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, confidence: 0.95, label: "stripe_key" },
  { ruleId: "SEC-001", regex: /AKIA[0-9A-Z]{16}/g, confidence: 0.95, label: "aws_access_key_id" },
  { ruleId: "SEC-001", regex: /AIza[0-9A-Za-z\-_]{30,}/g, confidence: 0.9, label: "google_api_key" },
  { ruleId: "SEC-001", regex: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, confidence: 0.9, label: "sendgrid_key" },
  { ruleId: "SEC-001", regex: /glpat-[A-Za-z0-9_-]{16,}/g, confidence: 0.9, label: "gitlab_token" },
  { ruleId: "SEC-003", regex: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, confidence: 0.95, label: "github_token" },
  { ruleId: "SEC-003", regex: /github_pat_[A-Za-z0-9_]{20,}/g, confidence: 0.95, label: "github_fine_grained_pat" },
  { ruleId: "SEC-003", regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g, confidence: 0.95, label: "slack_token" },
  { ruleId: "SEC-003", regex: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, confidence: 0.8, label: "jwt" },
  { ruleId: "SEC-003", regex: /(?:Bearer|token)\s+[A-Za-z0-9\-._~+/]{24,}=*/g, confidence: 0.6, label: "bearer_token" },
];

const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/;
const CREDENTIAL_URL_PATTERN = /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s:'"]+:[^\s@'"]+@/i;
const BASIC_AUTH_URL_PATTERN = /https?:\/\/[^\s:/\-'"]+:[^\s@'"]{3,}@[^\s'"]+/i;

const SECRET_ASSIGNMENT =
  /(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret|db[_-]?pass|smtp[_-]?password|signing[_-]?key)\s*[:=]\s*['"`]([^'"`\n]{8,120})['"`]/i;

const QUOTED_LONG_VALUE = /['"`]([A-Za-z0-9+/_\-]{24,120})['"`]/g;

export function runSecretsEngine(ctx: EngineContext): RawFinding[] {
  const findings: RawFinding[] = [];
  const seen = new Set<string>();
  const emit = (finding: RawFinding) => {
    const key = `${finding.ruleId}:${finding.filePath}:${finding.lineStart ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  for (const file of ctx.files) {
    const content = file.content ?? "";
    if (!content) continue;
    const testPath = isTestPath(file.path);
    const docPath = isDocPath(file.path);

    // SEC-002 — private keys, checked per file so the location is exact.
    const keyMatches = matchLines(content, new RegExp(PRIVATE_KEY_PATTERN.source, "g"), 5);
    if (keyMatches.length > 0) {
      const line = keyMatches[0]!.line;
      emit(
        makeFinding({
          ruleId: "SEC-002",
          path: file.path,
          line,
          snippet: `-----BEGIN … PRIVATE KEY----- (block masked)`,
          confidence: 0.96,
          toolReference: `secrets-engine:${file.path}:${line}`,
          metadata: { privateKeyFile: /\.(pem|key|ppk)$/i.test(file.path) },
        }),
      );
    }

    // SEC-006 / SEC-007 — credentials inside URLs.
    for (const match of matchLines(content, new RegExp(CREDENTIAL_URL_PATTERN.source, "gi"), 10)) {
      const raw = match.match[0];
      emit(
        makeFinding({
          ruleId: "SEC-006",
          path: file.path,
          line: match.line,
          snippet: snippetAround(content, match.line, 1).replace(raw, maskValue(raw, 6)),
          confidence: 0.9,
          toolReference: `secrets-engine:${file.path}:${match.line}`,
          metadata: { maskedValue: maskValue(raw, 6) },
        }),
      );
    }
    for (const match of matchLines(content, new RegExp(BASIC_AUTH_URL_PATTERN.source, "gi"), 10)) {
      const raw = match.match[0];
      emit(
        makeFinding({
          ruleId: "SEC-007",
          path: file.path,
          line: match.line,
          snippet: snippetAround(content, match.line, 1).replace(raw, maskValue(raw, 4)),
          confidence: 0.88,
          toolReference: `secrets-engine:${file.path}:${match.line}`,
          metadata: { maskedValue: maskValue(raw, 4) },
        }),
      );
    }

    // Provider tokens.
    for (const pattern of PROVIDER_PATTERNS) {
      for (const match of matchLines(content, pattern.regex, 20)) {
        const raw = match.match[0];
        if (looksPlaceholder(raw)) continue;
        const value = pattern.valueGroup ? match.match[pattern.valueGroup] ?? raw : raw;
        emit(
          makeFinding({
            ruleId: pattern.ruleId,
            path: file.path,
            line: match.line,
            snippet: `key: ${maskValue(value, 4)}`,
            confidence: testPath ? Math.min(pattern.confidence, 0.7) : pattern.confidence,
            toolReference: `secrets-engine:${file.path}:${match.line}:${pattern.label}`,
            metadata: { maskedValue: maskValue(value, 4), pattern: pattern.label, inTestPath: testPath },
          }),
        );
      }
    }

    // Keyword assignment (SEC-001) and entropy-only candidates (SEC-005).
    if (!docPath) {
      for (const match of matchLines(content, new RegExp(SECRET_ASSIGNMENT.source, "gi"), 40)) {
        const value = match.match[1] ?? "";
        if (!value || looksPlaceholder(value)) continue;
        const entropy = shannonEntropy(value);
        const strong = entropy > 3.2 || value.length >= 20;
        emit(
          makeFinding({
            ruleId: "SEC-001",
            path: file.path,
            line: match.line,
            snippet: snippetAround(content, match.line, 1).replace(value, maskValue(value, 3)),
            confidence: testPath ? 0.6 : strong ? 0.85 : 0.7,
            toolReference: `secrets-engine:${file.path}:${match.line}:assignment`,
            metadata: { maskedValue: maskValue(value, 3), entropy: Number(entropy.toFixed(2)), inTestPath: testPath },
          }),
        );
        seen.add(`SEC-005:${file.path}:${match.line}`);
      }

      for (const match of matchLines(content, new RegExp(QUOTED_LONG_VALUE.source, "g"), 60)) {
        const key = `SEC-005:${file.path}:${match.line}`;
        if (seen.has(key)) continue;
        const value = match.match[1] ?? "";
        if (value.length < 28 || looksPlaceholder(value)) continue;
        const entropy = shannonEntropy(value);
        if (entropy < 3.9) continue;
        const context = snippetAround(content, match.line, 4);
        if (!/(secret|key|token|password|credential|auth|private)/i.test(context)) continue;
        seen.add(key);
        emit(
          makeFinding({
            ruleId: "SEC-005",
            path: file.path,
            line: match.line,
            snippet: snippetAround(content, match.line, 1).replace(value, maskValue(value, 3)),
            confidence: testPath ? 0.45 : 0.6,
            toolReference: `secrets-engine:${file.path}:${match.line}:entropy`,
            metadata: { maskedValue: maskValue(value, 3), entropy: Number(entropy.toFixed(2)) },
          }),
        );
      }
    }

    // SEC-004 — a real environment file committed with real values.
    const name = file.path.split("/").pop() ?? file.path;
    if (/^\.env(\.[a-z0-9]+)?$/i.test(name) && !name.endsWith(".example") && !name.endsWith(".sample")) {
      const valueLines = content
        .split("\n")
        .map((line, index) => ({ line: index + 1, text: line.trim() }))
        .filter((row) => {
          const assign = row.text.match(/^[A-Z0-9_]+\s*=\s*(.+)$/);
          if (!assign) return false;
          const value = assign[1]!.trim();
          return value.length >= 6 && !looksPlaceholder(value) && !/^["']?\$/.test(value);
        });
      if (valueLines.length > 0) {
        emit(
          makeFinding({
            ruleId: "SEC-004",
            path: file.path,
            line: valueLines[0]!.line,
            lineEnd: valueLines[valueLines.length - 1]!.line,
            snippet: valueLines
              .slice(0, 6)
              .map((row) => row.text.replace(/=(.*)$/, "= ********"))
              .join("\n"),
            confidence: 0.85,
            toolReference: `secrets-engine:${file.path}:env-file`,
            metadata: { valueCount: valueLines.length },
          }),
        );
      }
    }
  }

  return findings;
}
