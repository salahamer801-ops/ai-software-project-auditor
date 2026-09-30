/**
 * Evidence layer (§25) — `lib/analysis/evidence.ts`.
 *
 * Two properties matter here: the fingerprint identifies the *issue* (stable across line
 * shifts, different for another rule/file/symbol) and a finding is only kept when it points
 * at a file that exists in the analysed manifest.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  countBySeverity,
  fingerprintFor,
  maskSnippet,
  normaliseFindings,
  severityRank,
} from "../lib/analysis/evidence";
import { findingOf, fileMap, normalise, snapshotOf, demoSecret } from "./helpers";

const SECRET = demoSecret("sk", "live", "abcdef1234567890abcdef");

const snapshot = snapshotOf([
  {
    path: "src/a.ts",
    content: `export function login() {\n  const apiKey = '${SECRET}';\n  return apiKey;\n}\n`,
  },
  { path: "src/b.ts", content: "export const b = 1;\n" },
  { path: "tests/a.test.ts", content: `const k = '${SECRET}';\n` },
]);

describe("fingerprintFor", () => {
  test("is stable across line shifts, reindentation and whitespace noise", () => {
    const base = fingerprintFor({ ruleId: "SEC-001", filePath: "src/a.ts", anchorText: "const apiKey = x;" });
    const shifted = fingerprintFor({ ruleId: "SEC-001", filePath: "src/a.ts", anchorText: "    const   apiKey = x;   " });
    assert.equal(base, shifted, "the same line, reformatted, must keep the same fingerprint");
    assert.match(base, /^[0-9a-f]{32}$/, "the fingerprint is a 32-character digest");
  });

  test("ignores digits in the anchor text so it survives unrelated edits", () => {
    const first = fingerprintFor({ ruleId: "SEC-001", filePath: "src/a.ts", anchorText: "user 12 logged in" });
    const second = fingerprintFor({ ruleId: "SEC-001", filePath: "src/a.ts", anchorText: "user 99 logged in" });
    assert.equal(first, second, "a changed number on the same line must not create a new issue");
  });

  test("differs for a different rule, file or symbol", () => {
    const anchor = { filePath: "src/a.ts", anchorText: "const apiKey = x;" };
    const baseline = fingerprintFor({ ruleId: "SEC-001", ...anchor });
    assert.notEqual(
      fingerprintFor({ ruleId: "SEC-002", ...anchor }),
      baseline,
      "a different rule must produce a different fingerprint",
    );
    assert.notEqual(
      fingerprintFor({ ruleId: "SEC-001", filePath: "src/b.ts", anchorText: anchor.anchorText }),
      baseline,
      "a different file must produce a different fingerprint",
    );
    assert.notEqual(
      fingerprintFor({ ruleId: "SEC-001", ...anchor, symbol: "login" }),
      baseline,
      "a symbol anchor must produce a different fingerprint than a line anchor",
    );
    assert.notEqual(
      fingerprintFor({ ruleId: "SEC-001", ...anchor, symbol: "login" }),
      fingerprintFor({ ruleId: "SEC-001", ...anchor, symbol: "logout" }),
      "a different symbol must produce a different fingerprint",
    );
  });

  test("prefers the symbol and falls back to `file` when there is nothing else", () => {
    const withSymbol = fingerprintFor({ ruleId: "SEC-001", filePath: "src/a.ts", symbol: "login" });
    assert.equal(
      fingerprintFor({ ruleId: "SEC-001", filePath: "src/a.ts", symbol: "login", anchorText: "ignored" }),
      withSymbol,
      "the symbol wins over the anchor text",
    );
    assert.match(
      fingerprintFor({ ruleId: "SEC-001", filePath: "src/a.ts" }),
      /^[0-9a-f]{32}$/,
      "a file-level fingerprint still hashes deterministically",
    );
    assert.equal(
      fingerprintFor({ ruleId: "SEC-001", filePath: "src/a.ts" }),
      fingerprintFor({ ruleId: "SEC-001", filePath: "src/a.ts", anchorText: null }),
      "no anchor and a null anchor mean the same thing",
    );
  });
});

describe("maskSnippet", () => {
  test("caps what it returns and passes nothing through when there is nothing", () => {
    const masked = maskSnippet("x".repeat(5000));
    assert.ok(masked, "a snippet must be returned for a long input");
    assert.ok(masked.length <= 2000, `maskSnippet returned ${masked.length} characters — the cap is 2000`);
    assert.equal(maskSnippet(undefined), null, "no snippet means null");
    assert.equal(maskSnippet(""), null, "an empty snippet means null");
  });

  test("redacts credential-shaped text", () => {
    // Without a credential-looking variable name only the provider pattern fires, so the
    // prefix survives and the report can still say what kind of key it was.
    const prefixKept = maskSnippet(`const provider = '${SECRET}'; // deploy`);
    assert.ok(prefixKept);
    assert.ok(!prefixKept.includes(SECRET), "the full secret must not survive masking");
    assert.ok(prefixKept.includes("sk_live_"), "the provider prefix stays readable for the report");
    assert.match(prefixKept, /sk_live_\*+/, "the value is replaced by asterisks");
    assert.ok(prefixKept.includes("// deploy"), "the rest of the snippet is untouched");

    // With a credential-looking name the whole value is masked, prefix included.
    const fullyMasked = maskSnippet(`const apiKey = '${SECRET}';`);
    assert.ok(fullyMasked);
    assert.ok(!fullyMasked.includes(SECRET), "the secret must be gone");
    assert.ok(!fullyMasked.includes("sk_live_"), "an apiKey assignment is masked as a whole");
    assert.ok(fullyMasked.includes("apiKey = '"));
  });
});

describe("normaliseFindings", () => {
  test("drops a finding whose file is not in the manifest and records the reference", () => {
    const result = normaliseFindings(
      [{ ruleId: "SEC-001", filePath: "src/ghost.ts", lineStart: 1 }],
      { runId: "run_test", projectId: "prj_test", snapshot, fileByPath: fileMap(snapshot) },
    );
    assert.equal(result.findings.length, 0, "an ungrounded finding must not be kept");
    assert.equal(result.dropped, 1, "the dropped finding is counted");
    assert.deepEqual(
      result.rejectedReferences,
      ["SEC-001 → src/ghost.ts"],
      "the rejected reference must be recorded for the limitations list",
    );
  });

  test("drops a finding whose rule is not in the catalogue", () => {
    const result = normaliseFindings(
      [{ ruleId: "NOPE-999", filePath: "src/a.ts" }],
      { runId: "run_test", projectId: "prj_test", snapshot, fileByPath: fileMap(snapshot) },
    );
    assert.equal(result.findings.length, 0, "an unknown rule must not produce a finding");
    assert.equal(result.dropped, 1);
    assert.deepEqual(result.rejectedReferences, [], "an unknown rule is not an evidence problem");
  });

  test("applies the rule's severity, version and metadata to the finding", () => {
    const finding = findingOf(
      { ruleId: "SEC-001", filePath: "src/a.ts", lineStart: 2, snippet: `const apiKey = '${SECRET}';` },
      snapshot,
    );
    assert.equal(finding.ruleId, "SEC-001");
    assert.equal(finding.severity, "HIGH", "severity comes from the rule when there is no override");
    assert.equal(finding.severitySource, "rule");
    assert.equal(finding.engine, "secrets");
    assert.equal(finding.category, "secrets");
    assert.ok(finding.ruleVersion.trim().length > 0, "the finding must record the rule version");
    assert.equal(finding.status, "open");
    assert.equal(finding.auditRunId, "run_test");
    assert.equal(finding.projectId, "prj_test");
    assert.equal(finding.lineStart, 2);
    assert.equal(finding.lineEnd, 2, "a single-line finding ends on its own line");
    assert.equal(finding.metadata.occurrences, 1);
    assert.match(finding.id, /^fnd_[0-9a-z]{20}$/, "finding ids are unique per run");
    assert.ok(finding.confidence > 0 && finding.confidence <= 1);
    assert.ok(finding.title.ar.length > 0 && finding.title.en.length > 0, "the finding is bilingual");
  });

  test("a severity override wins and is labelled as coming from context", () => {
    const finding = findingOf(
      {
        ruleId: "SEC-001",
        filePath: "src/a.ts",
        lineStart: 2,
        severityOverride: "CRITICAL",
        severityReason: "reachable from an unauthenticated route",
      },
      snapshot,
    );
    assert.equal(finding.severity, "CRITICAL");
    assert.equal(finding.severitySource, "context", "an override must be attributed to the context");
    assert.equal(finding.severityReason, "reachable from an unauthenticated route");
  });

  test("lowers confidence inside a test path but never below the floor", () => {
    const inTest = findingOf({ ruleId: "SEC-001", filePath: "tests/a.test.ts", lineStart: 1 }, snapshot);
    const inSource = findingOf({ ruleId: "SEC-001", filePath: "src/a.ts", lineStart: 2 }, snapshot);
    assert.ok(inTest.confidence < inSource.confidence, "a test-path hit is less certain than a source hit");
    assert.ok(inTest.confidence >= 0.2, "confidence must not fall below the floor");
    assert.ok(inSource.confidence <= 0.99, "confidence must not reach certainty");
  });

  test("deduplicates the same fingerprint and keeps the several occurrences as evidence", () => {
    const result = normaliseFindings(
      [
        { ruleId: "SEC-001", filePath: "src/a.ts", lineStart: 2, snippet: "first sighting" },
        { ruleId: "SEC-001", filePath: "src/a.ts", lineStart: 2, snippet: "second sighting" },
      ],
      { runId: "run_test", projectId: "prj_test", snapshot, fileByPath: fileMap(snapshot) },
    );
    assert.equal(result.findings.length, 1, "the same issue at the same site is one finding");
    const [finding] = result.findings;
    assert.equal(finding.metadata.occurrences, 2, "the occurrence count must be incremented");
    assert.equal(finding.evidence.length, 2, "both pieces of evidence are kept");
    assert.equal(result.dropped, 0);
    assert.deepEqual(result.rejectedReferences, []);
  });

  test("masks evidence snippets before they are stored", () => {
    const finding = findingOf(
      { ruleId: "SEC-001", filePath: "src/a.ts", lineStart: 2, snippet: `const apiKey = '${SECRET}';` },
      snapshot,
    );
    const stored = JSON.stringify(finding);
    assert.ok(!stored.includes(SECRET), "the raw secret must not reach the finding");
    assert.match(finding.evidence[0].sourceReference, /^src\/a\.ts:2$/, "evidence points at file:line");
    assert.equal(finding.evidence[0].sourceType, "code");
  });

  test("orders findings by severity, most severe first", () => {
    const findings = normalise([
      { ruleId: "DEP-004", filePath: "src/a.ts", lineStart: 1, snippet: "info" },
      { ruleId: "SEC-005", filePath: "src/b.ts", lineStart: 1, snippet: "medium" },
      { ruleId: "SEC-002", filePath: "src/a.ts", lineStart: 2, snippet: "critical" },
      { ruleId: "SEC-001", filePath: "src/b.ts", lineStart: 1, snippet: "high" },
    ], snapshot);
    assert.deepEqual(
      findings.map((finding) => finding.severity),
      ["CRITICAL", "HIGH", "MEDIUM", "INFO"],
      "findings must be sorted by severity",
    );
  });
});

describe("severity helpers", () => {
  test("severityRank agrees with the severity order", () => {
    assert.equal(severityRank("INFO"), 0);
    assert.equal(severityRank("LOW"), 1);
    assert.equal(severityRank("MEDIUM"), 2);
    assert.equal(severityRank("HIGH"), 3);
    assert.equal(severityRank("CRITICAL"), 4);
    assert.ok(severityRank("CRITICAL") > severityRank("INFO"));
  });

  test("countBySeverity counts every level and always returns all five keys", () => {
    const findings = normalise([
      { ruleId: "SEC-002", filePath: "src/a.ts", lineStart: 2, snippet: "critical" },
      { ruleId: "SEC-001", filePath: "src/b.ts", lineStart: 1, snippet: "high" },
      { ruleId: "DEP-003", filePath: "src/b.ts", lineStart: 1, snippet: "low" },
    ], snapshot);
    const counts = countBySeverity(findings);
    assert.deepEqual(Object.keys(counts).sort(), ["CRITICAL", "HIGH", "INFO", "LOW", "MEDIUM"]);
    assert.equal(counts.CRITICAL, 1);
    assert.equal(counts.HIGH, 1);
    assert.equal(counts.LOW, 1);
    assert.equal(counts.MEDIUM, 0);
    assert.equal(counts.INFO, 0);
    assert.deepEqual(countBySeverity([]), { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 });
  });
});
