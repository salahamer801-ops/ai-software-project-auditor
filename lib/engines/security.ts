import type { RawFinding } from "../types";
import type { EngineContext } from "./shared";
import { findLine, isDocPath, isTestPath, makeFinding, matchLines, snippetAround } from "./shared";

interface SecurityPattern {
  ruleId: string;
  regex: RegExp;
  languages?: string[];
  confidence: number;
  /** The matched line (or a small window) must also contain this to count. */
  requireNear?: RegExp;
  /** Skip when the surrounding window matches this (typical guard already present). */
  avoidNear?: RegExp;
  /** Skip documentation files (examples of bad code exist in docs). */
  skipDocs?: boolean;
}

const PATTERNS: SecurityPattern[] = [
  {
    ruleId: "SEC-101",
    regex: /\beval\s*\(|new\s+Function\s*\(/,
    languages: ["javascript", "typescript", "php"],
    confidence: 0.85,
    skipDocs: true,
  },
  {
    ruleId: "SEC-101",
    regex: /\bexec\s*\(\s*(?:request|req\.|input|data|user)/,
    languages: ["python"],
    confidence: 0.7,
    skipDocs: true,
  },
  {
    ruleId: "SEC-102",
    regex: /\b(?:exec|execSync|spawn|spawnSync|fork)\s*\([^)]*\+/,
    languages: ["javascript", "typescript"],
    confidence: 0.8,
    skipDocs: true,
  },
  {
    ruleId: "SEC-102",
    regex: /\b(?:shell_exec|passthru|system|popen)\s*\(\s*\$/,
    languages: ["php"],
    confidence: 0.8,
    skipDocs: true,
  },
  {
    ruleId: "SEC-116",
    regex: /subprocess\.(?:run|call|check_output|check_call|Popen)\s*\([^)]*shell\s*=\s*True/,
    languages: ["python"],
    confidence: 0.85,
    skipDocs: true,
  },
  {
    ruleId: "SEC-103",
    regex: /(?:query|execute|raw|whereRaw|selectRaw|queryRaw|executeQuery|createQuery)\s*\(\s*['"`][^'"`]*(?:SELECT|INSERT|UPDATE|DELETE)[^'"`]*['"`]\s*\+/i,
    confidence: 0.82,
    skipDocs: true,
  },
  {
    ruleId: "SEC-103",
    regex: /['"`]\s*(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)[^'"`]{5,}['"`]\s*(?:\+|\|\|)\s*(?:req\.|request\.|params|\w*id\b|\w*email\b)/i,
    confidence: 0.8,
    skipDocs: true,
  },
  {
    ruleId: "SEC-104",
    regex: /dangerouslySetInnerHTML|\.innerHTML\s*=|v-html\s*=/,
    languages: ["javascript", "typescript", "php"],
    confidence: 0.72,
    skipDocs: true,
  },
  {
    ruleId: "SEC-105",
    regex: /\b(?:readFile|readFileSync|createReadStream|writeFile|writeFileSync|unlink|sendFile)\s*\([^)]*\+/,
    languages: ["javascript", "typescript"],
    confidence: 0.62,
    requireNear: /(?:req\.|request\.|params|query|body|user|path\.join)/,
    skipDocs: true,
  },
  {
    ruleId: "SEC-105",
    regex: /(?:open|Path)\s*\([^)]*\+\s*(?:request|user|input|filename)/,
    languages: ["python"],
    confidence: 0.6,
    skipDocs: true,
  },
  {
    ruleId: "SEC-106",
    regex: /\bpickle\.loads?\s*\(|\bunserialize\s*\(|\byaml\.load\s*\(|ObjectInputStream|Marshal\.load/,
    confidence: 0.82,
    avoidNear: /SafeLoader|safe_load|allowed_classes/,
    skipDocs: true,
  },
  {
    ruleId: "SEC-107",
    regex: /createHash\(\s*['"](?:md5|sha1)['"]|MessageDigest\.getInstance\(\s*['"](?:MD5|SHA-1)['"]|md5\s*\(\s*(?:password|pass|pwd)|sha1\s*\(\s*(?:password|pass|pwd)|\bmd5\s*\(/i,
    confidence: 0.78,
    requireNear: /password|pass|pwd|hash|credential/i,
    skipDocs: true,
  },
  {
    ruleId: "SEC-108",
    regex: /\bMath\.random\s*\(\s*\)|\brandom\.random\s*\(\s*\)|\brand\s*\(\s*\)\s*%/,
    confidence: 0.7,
    requireNear: /token|secret|otp|code|nonce|reset|session|password/i,
    skipDocs: true,
  },
  {
    ruleId: "SEC-110",
    regex: /origin\s*:\s*['"]\*['"]|Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*['"]|cors\(\s*\{\s*origin\s*:\s*true/,
    confidence: 0.85,
    skipDocs: true,
  },
  {
    ruleId: "SEC-111",
    regex: /(?:APP_DEBUG|DEBUG|debug|app\.debug)\s*[:=]\s*(?:true|True|1|'true'|"true")|DEVELOPMENT\s*=\s*1/,
    confidence: 0.7,
    skipDocs: true,
  },
  {
    ruleId: "SEC-112",
    regex: /(?:console\.(?:log|info|warn|error)|print|logger\.\w+|Log\.\w+|puts|System\.out\.println)\s*\([^)]{0,200}(?:password|passwd|token|secret|authorization|credit_?card|card_?number|api_?key)/i,
    confidence: 0.7,
    skipDocs: true,
  },
  {
    ruleId: "SEC-113",
    regex: /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|curl\s+-k\b|verify\s*:\s*false/,
    confidence: 0.85,
    skipDocs: true,
  },
  {
    ruleId: "SEC-114",
    regex: /(?:res\.redirect|response\.redirect|redirect|RedirectResponse)\s*\(\s*(?:req\.|request\.|ctx\.)|(?:\bfetch|axios\.get|axios\.post|requests\.get|http\.get)\s*\(\s*(?:req\.|request\.)/,
    confidence: 0.6,
    skipDocs: true,
  },
  {
    ruleId: "SEC-115",
    regex: /localStorage\.setItem\(\s*['"][^'"]*(?:token|jwt|session|auth)/i,
    languages: ["javascript", "typescript"],
    confidence: 0.7,
    skipDocs: true,
  },
  {
    ruleId: "SEC-117",
    regex: /@csrf_exempt|csrf_protect\s*=\s*False/,
    languages: ["python"],
    confidence: 0.7,
    skipDocs: true,
  },
  {
    ruleId: "SEC-118",
    regex: /\$guarded\s*=\s*\[\s*\]|\$fillable\s*=\s*\[\s*['"]\*['"]|protected\s+\$guarded\s*=\s*\[\s*\]/,
    languages: ["php"],
    confidence: 0.65,
    skipDocs: true,
  },
];

export function runSecurityEngine(ctx: EngineContext): RawFinding[] {
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
    const docPath = isDocPath(file.path);
    const testPath = isTestPath(file.path);
    const lines = content.split("\n");

    for (const pattern of PATTERNS) {
      if (pattern.languages && !pattern.languages.includes(file.language)) continue;
      if (pattern.skipDocs && docPath) continue;
      for (const match of matchLines(content, pattern.regex, 25)) {
        const window = lines.slice(Math.max(0, match.line - 5), match.line + 4).join("\n");
        if (pattern.requireNear && !pattern.requireNear.test(window)) continue;
        if (pattern.avoidNear && pattern.avoidNear.test(window)) continue;
        emit(
          makeFinding({
            ruleId: pattern.ruleId,
            path: file.path,
            line: match.line,
            snippet: snippetAround(content, match.line, 2),
            confidence: testPath ? Math.max(0.4, pattern.confidence - 0.2) : pattern.confidence,
            toolReference: `security-engine:${file.path}:${match.line}`,
            metadata: { inTestPath: testPath },
          }),
        );
      }
    }

    // SEC-109 — file uploads without an explicit limit or type filter.
    if (/(multer\s*\(|FileInterceptor|request\.files|files\s*=\s*request\.files|MultipartFile|upload\.single)/.test(content)) {
      const hasLimit = /(limits\s*:|fileSize|maxFileSize|max_file_size|MAX_CONTENT_LENGTH|file_size|allowed_?types|mimetype|contentType|accept\s*:)/i.test(content);
      const hasFilter = /(fileFilter|mimetype|contentType|validateFile|allowedExtensions)/i.test(content);
      if (!hasLimit || !hasFilter) {
        const line = findLine(content, /multer\s*\(|FileInterceptor|request\.files|MultipartFile|upload\.single/) ?? 1;
        emit(
          makeFinding({
            ruleId: "SEC-109",
            path: file.path,
            line,
            snippet: snippetAround(content, line, 3),
            confidence: hasLimit || hasFilter ? 0.5 : 0.65,
            toolReference: `security-engine:${file.path}:upload`,
            metadata: { missingSizeLimit: !hasLimit, missingTypeFilter: !hasFilter },
          }),
        );
      }
    }

    // SEC-119 — commented-out code blocks left in place.
    if (!docPath && lines.length > 20) {
      let runStart = -1;
      let runCount = 0;
      for (let index = 0; index <= lines.length; index += 1) {
        const line = lines[index] ?? "";
        const isComment = /^\s*(?:\/\/|#)\s*\S/.test(line) && /[;{}=()]/.test(line) && !/^\s*(?:\/\/|#)\s*(?:TODO|FIXME|NOTE|eslint|@ts-|phpcs|noqa|type:)/i.test(line);
        if (isComment) {
          if (runStart < 0) runStart = index;
          runCount += 1;
        } else {
          if (runCount >= 5 && runStart >= 0 && content.includes("function") ) {
            emit(
              makeFinding({
                ruleId: "SEC-119",
                path: file.path,
                line: runStart + 1,
                lineEnd: runStart + runCount,
                snippet: lines.slice(runStart, runStart + 6).join("\n"),
                confidence: 0.6,
                toolReference: `security-engine:${file.path}:commented-code:${runStart + 1}`,
                metadata: { commentBlockLines: runCount },
              }),
            );
          }
          runStart = -1;
          runCount = 0;
        }
      }
    }
  }

  return findings;
}
