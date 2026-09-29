import type { RawFinding, TestRunRecord } from "../types";
import type { EngineContext } from "./shared";
import { isTestFile } from "./stack";
import { isDocPath, makeFinding, matchLines, snippetAround } from "./shared";

/**
 * Test engine (§23).
 *
 * We do NOT execute the project's tests — that would mean running untrusted code on the
 * host. What we can do deterministically:
 *  - detect the framework and count the test cases that exist in the source;
 *  - read test results and coverage that the project itself committed (JUnit XML,
 *    coverage-summary.json, lcov.info);
 *  - report failing tests and low coverage from that evidence, and say plainly that no
 *    test was executed here.
 */

export interface TestEngineResult {
  findings: RawFinding[];
  testRuns: TestRunRecord[];
  notes: string[];
}

interface JunitSummary {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  timeMs: number | null;
  failedCases: string[];
  sourceReference: string;
}

function parseJunit(path: string, content: string): JunitSummary | null {
  const suite = content.match(/<testsuites\b[^>]*>/i);
  const numbers: Record<string, number> = {};
  const attrs = suite?.[0] ?? content.match(/<testsuite\b[^>]*>/i)?.[0] ?? "";
  for (const attr of attrs.matchAll(/(tests|failures|errors|skipped|time)="([\d.]+)"/gi)) {
    numbers[attr[1]!.toLowerCase()] = Number(attr[2]);
  }
  if (numbers.tests === undefined && !/<testcase/i.test(content)) return null;

  let tests = numbers.tests ?? 0;
  let failures = numbers.failures ?? 0;
  const errors = numbers.errors ?? 0;
  let skipped = numbers.skipped ?? 0;

  if (!tests) {
    tests = (content.match(/<testcase\b/gi) ?? []).length;
    failures = (content.match(/<failure\b/gi) ?? []).length;
    skipped = (content.match(/<skipped\b/gi) ?? []).length;
  }

  const failedCases: string[] = [];
  for (const match of content.matchAll(/<testcase\b[^>]*name="([^"]*)"[^>]*>[\s\S]{0,2000}?<(failure|error)\b/gi)) {
    if (failedCases.length < 10) failedCases.push(match[1] ?? "unnamed test");
  }

  return {
    tests,
    failures: failures + errors,
    errors,
    skipped,
    timeMs: numbers.time ? Math.round(numbers.time * 1000) : null,
    failedCases,
    sourceReference: path,
  };
}

function parseCoverageSummary(path: string, content: string): number | null {
  try {
    const data = JSON.parse(content) as {
      total?: { lines?: { pct?: number }; statements?: { pct?: number } };
    };
    const pct = data.total?.lines?.pct ?? data.total?.statements?.pct;
    return typeof pct === "number" ? Number(pct.toFixed(2)) : null;
  } catch {
    return null;
  }
}

function parseLcov(content: string): number | null {
  let found = 0;
  let hit = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith("LF:")) found += Number(line.slice(3).trim()) || 0;
    if (line.startsWith("LH:")) hit += Number(line.slice(3).trim()) || 0;
  }
  if (found === 0) return null;
  return Number(((hit / found) * 100).toFixed(2));
}

export function runTestsEngine(ctx: EngineContext): TestEngineResult {
  const findings: RawFinding[] = [];
  const testRuns: TestRunRecord[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const emit = (finding: RawFinding) => {
    const key = `${finding.ruleId}:${finding.filePath}:${finding.lineStart ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  const testFiles = ctx.files.filter((file) => file.text && !isDocPath(file.path) && isTestFile(file.path));
  const framework = ctx.snapshot.stack.testFrameworks[0] ?? null;

  let cases = 0;
  for (const file of testFiles) {
    const content = file.content ?? "";
    cases += (content.match(/\b(?:it|test|specify|check)\s*\(/g) ?? []).length;
    cases += (content.match(/^\s*(?:async\s+)?def\s+test_[a-z0-9_]+/gim) ?? []).length;
    cases += (content.match(/^\s*func\s+Test[A-Z]\w*\s*\(/gm) ?? []).length;
    cases += (content.match(/^\s*(?:it|scenario)\s+['"]/gm) ?? []).length;
  }

  const scriptTexts = ctx.files
    .filter((file) => ["package.json", "composer.json", "pyproject.toml", "Makefile"].includes(file.path.split("/").pop() ?? ""))
    .map((file) => file.content ?? "")
    .join("\n");
  const hasTestScript = /"(?:test|test:unit|phpunit)"\s*:|pytest|phpunit|\btest:/i.test(scriptTexts);

  const junit = ctx.files
    .filter((file) => /(junit|test-results|test-results\.xml|results\.xml)/i.test(file.path) && file.content)
    .map((file) => parseJunit(file.path, file.content ?? ""))
    .find((result) => result !== null) ?? null;

  const coverageFile = ctx.files.find(
    (file) => /coverage-summary\.json$/i.test(file.path) || /coverage\.json$/i.test(file.path),
  );
  const lcovFile = ctx.files.find((file) => /lcov\.info$/i.test(file.path));
  const coverage = coverageFile
    ? parseCoverageSummary(coverageFile.path, coverageFile.content ?? "")
    : lcovFile
      ? parseLcov(lcovFile.content ?? "")
      : null;

  const executed = false;
  const command = (() => {
    const pkg = ctx.files.find((file) => file.path.endsWith("package.json"));
    if (pkg && /"test"\s*:/.test(pkg.content ?? "")) return "npm test (declared, not executed here)";
    if (ctx.files.some((file) => file.path.endsWith("composer.json"))) return "phpunit (declared, not executed here)";
    if (ctx.files.some((file) => file.path.endsWith("pytest.ini") || file.path.endsWith("pyproject.toml")))
      return "pytest (declared, not executed here)";
    return null;
  })();

  if (junit) {
    testRuns.push({
      framework: framework ?? "unknown",
      command,
      status: "parsed",
      executed,
      passed: Math.max(0, junit.tests - junit.failures - junit.skipped),
      failed: junit.failures,
      skipped: junit.skipped,
      coveragePercent: coverage,
      durationMs: junit.timeMs,
      outputExcerpt: junit.failedCases.slice(0, 5).join("\n") || null,
      sourceReference: junit.sourceReference,
    });
    if (junit.failures > 0) {
      emit(
        makeFinding({
          ruleId: "TST-002",
          path: junit.sourceReference,
          line: Math.max(1, matchLines(ctx.files.find((file) => file.path === junit.sourceReference)?.content ?? "", /<failure/) [0]?.line ?? 1),
          snippet: junit.failedCases.slice(0, 6).join("\n"),
          confidence: 0.95,
          toolReference: `test-engine:junit:${junit.sourceReference}`,
          severityReason: `${junit.failures} failing cases in the committed JUnit report (${junit.tests} total).`,
          metadata: { tests: junit.tests, failures: junit.failures, skipped: junit.skipped },
          extraEvidence: [
            {
              sourceType: "test_result" as const,
              sourceReference: junit.sourceReference,
              snippet: `${junit.tests} tests, ${junit.failures} failing, ${junit.skipped} skipped`,
            },
          ],
        }),
      );
    }
  } else {
    testRuns.push({
      framework: framework ?? "unknown",
      command,
      status: testFiles.length > 0 ? "detected" : "not_run",
      executed,
      passed: null,
      failed: null,
      skipped: null,
      coveragePercent: coverage,
      durationMs: null,
      outputExcerpt: null,
      sourceReference: testFiles.length > 0 ? `${testFiles.length} test files detected (not executed here)` : null,
    });
  }

  if (coverage !== null && coverage < 50) {
    const path = coverageFile?.path ?? lcovFile?.path ?? "coverage";
    const content = coverageFile?.content ?? lcovFile?.content ?? "";
    emit(
      makeFinding({
        ruleId: "TST-003",
        path,
        line: 1,
        snippet: snippetAround(content, 1, 4),
        confidence: 0.9,
        severityReason: `Reported line coverage is ${coverage}%.`,
        toolReference: `test-engine:coverage:${path}`,
        metadata: { coveragePercent: coverage },
        extraEvidence: [
          {
            sourceType: "test_result" as const,
            sourceReference: path,
            snippet: `coverage: ${coverage}%`,
          },
        ],
      }),
    );
  }

  if (testFiles.length === 0 && !framework) {
    emit(
      makeFinding({
        ruleId: "TST-001",
        path: ctx.snapshot.stack.manifests[0] ?? ctx.files[0]!.path,
        line: 1,
        snippet: "No test file and no test framework were detected in this project.",
        confidence: 0.9,
        toolReference: "test-engine:no-tests",
        metadata: { scannedFiles: ctx.snapshot.totals.textFileCount, cases },
      }),
    );
  } else if (testFiles.length > 0 && !hasTestScript) {
    emit(
      makeFinding({
        ruleId: "TST-004",
        path: testFiles[0]!.path,
        line: 1,
        snippet: `Test files exist (${testFiles.length}) but no test script was found in the project manifests.`,
        confidence: 0.7,
        toolReference: `test-engine:no-script:${testFiles[0]!.path}`,
        metadata: { testFiles: testFiles.length },
      }),
    );
  }

  for (const file of testFiles) {
    const content = file.content ?? "";
    const skipMatches =
      matchLines(content, /\.(?:skip|only)\s*\(|\bxit\s*\(|\bxdescribe\s*\(|@Ignore\b|@Disabled\b/g, 6);
    if (skipMatches.length === 0) continue;
    emit(
      makeFinding({
        ruleId: "TST-005",
        path: file.path,
        line: skipMatches[0]!.line,
        snippet: skipMatches
          .slice(0, 4)
          .map((match) => match.text.trim())
          .join("\n"),
        confidence: 0.8,
        toolReference: `test-engine:skipped:${file.path}`,
        metadata: { count: skipMatches.length },
      }),
    );
  }

  notes.push(
    testFiles.length > 0
      ? `${testFiles.length} test files and ~${cases} test cases were found in the source (nothing was executed).`
      : "No test files were found in the project.",
  );
  if (junit) notes.push(`Committed JUnit report parsed: ${junit.tests} tests, ${junit.failures} failing.`);
  if (coverage !== null) notes.push(`Committed coverage report reports ${coverage}%.`);

  return { findings, testRuns, notes };
}
