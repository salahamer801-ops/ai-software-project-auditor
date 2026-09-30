/**
 * Audit summary and limitations (§26–§27) — `lib/analysis/summary.ts`.
 *
 * The verdict is what a developer quotes in a report, and the limitations list is what stops
 * the report from over-claiming, so both are asserted against the findings they were given.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildAuditSummary, buildLimitations, verdictFor } from "../lib/analysis/summary";
import type { EngineRunInfo, Finding } from "../lib/types";
import { normalise, snapshotOf, demoSecret } from "./helpers";

const snapshot = snapshotOf([
  { path: "src/a.ts", content: `const apiKey = '${demoSecret("sk", "live", "abcdef1234567890abcdef")}';\nexport const b = 1;\n` },
  { path: "src/b.ts", content: "export const c = 2;\n" },
  { path: "package.json", content: "{\n  \"dependencies\": { \"next\": \"15.5.26\" }\n}\n" },
]);

function findingsOf(...ruleIds: string[]): Finding[] {
  return normalise(
    ruleIds.map((ruleId, index) => ({
      ruleId,
      filePath: index % 2 === 0 ? "src/a.ts" : "src/b.ts",
      lineStart: 1,
      snippet: `finding ${ruleId}`,
    })),
    snapshot,
  );
}

describe("verdictFor", () => {
  test("CRITICAL for any critical finding", () => {
    assert.equal(verdictFor(findingsOf("SEC-002")), "CRITICAL");
    assert.equal(verdictFor(findingsOf("SEC-002", "DEP-004")), "CRITICAL", "one critical is enough");
  });

  test("ACTION_REQUIRED for a high finding without a critical one", () => {
    assert.equal(verdictFor(findingsOf("SEC-001")), "ACTION_REQUIRED");
    assert.equal(verdictFor(findingsOf("SEC-001", "DEP-003")), "ACTION_REQUIRED");
  });

  test("ATTENTION_REQUIRED for medium or low findings only", () => {
    assert.equal(verdictFor(findingsOf("SEC-005")), "ATTENTION_REQUIRED");
    assert.equal(verdictFor(findingsOf("DEP-003")), "ATTENTION_REQUIRED");
    assert.equal(verdictFor(findingsOf("SEC-005", "DEP-003")), "ATTENTION_REQUIRED");
  });

  test("CLEAN when there is nothing to report", () => {
    assert.equal(verdictFor([]), "CLEAN");
    assert.equal(verdictFor(findingsOf("DEP-004")), "CLEAN", "an INFO finding does not change the verdict");
  });
});

describe("buildAuditSummary", () => {
  const findings = findingsOf("SEC-001", "SEC-005", "DEP-004");

  test("counts findings by severity and by category", () => {
    const summary = buildAuditSummary({ findings, snapshot, engines: [] });
    assert.equal(summary.totalFindings, findings.length);
    assert.deepEqual(summary.severityCounts, { CRITICAL: 0, HIGH: 1, MEDIUM: 1, LOW: 0, INFO: 1 });
    assert.equal(summary.categoryCounts.secrets, 2);
    assert.equal(summary.categoryCounts.dependencies, 1);
    assert.equal(
      Object.values(summary.categoryCounts).reduce((sum, count) => sum + count, 0),
      findings.length,
      "category counts must add up to the finding count",
    );
    assert.deepEqual(summary.categorySeverity.secrets, { CRITICAL: 0, HIGH: 1, MEDIUM: 1, LOW: 0, INFO: 0 });
    assert.equal(summary.status, "ACTION_REQUIRED");
    assert.equal(summary.filesAnalyzed, snapshot.totals.textFileCount);
    assert.equal(summary.loc, snapshot.totals.loc);
  });

  test("carries the stack highlights and builds a highlight per top finding", () => {
    const summary = buildAuditSummary({ findings, snapshot, engines: [] });
    assert.ok(summary.stackHighlights.length > 0, "the detected stack must show up in the summary");
    assert.ok(summary.stackHighlights.some((line) => line.includes("Next.js")));
    assert.ok(summary.highlights.length > 0, "the most severe findings become highlights");
    assert.ok(summary.highlights.length <= 6, "highlights are capped");
    assert.ok(
      summary.highlights.some((highlight) => highlight.findingId !== null),
      "a generated highlight points at its finding",
    );
    const first = summary.highlights[0];
    assert.ok(first.text.en.length > 0 && first.text.ar.length > 0, "highlights are bilingual");
    assert.ok(first.text.en.includes("src/"), "a highlight names the file");
  });

  test("an AI headline and AI highlights replace the generated ones", () => {
    const summary = buildAuditSummary({
      findings,
      snapshot,
      engines: [],
      aiHeadline: { ar: "ملخص", en: "AI headline" },
      aiHighlights: [{ findingId: null, text: { ar: "أ", en: "AI highlight" } }],
    });
    assert.deepEqual(summary.headline, { ar: "ملخص", en: "AI headline" });
    assert.deepEqual(summary.highlights, [{ findingId: null, text: { ar: "أ", en: "AI highlight" } }]);
  });

  test("an empty highlight list falls back to the generated one", () => {
    const summary = buildAuditSummary({ findings, snapshot, engines: [], aiHighlights: [] });
    assert.ok(summary.highlights.length > 0, "an empty AI list must not blank the highlights");
    assert.ok(summary.headline.en.includes("findings"), "the generated headline states the counts");
  });

  test("an empty finding list is a clean report, not an error", () => {
    const summary = buildAuditSummary({ findings: [], snapshot, engines: [] });
    assert.equal(summary.status, "CLEAN");
    assert.equal(summary.totalFindings, 0);
    assert.deepEqual(summary.severityCounts, { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 });
    assert.deepEqual(summary.categoryCounts, {});
    assert.deepEqual(summary.highlights, []);
    assert.ok(summary.headline.ar.length > 0 && summary.headline.en.length > 0);
  });
});

describe("buildLimitations", () => {
  const base = {
    snapshot,
    engines: [],
    advisoriesVerified: true,
    testsExecuted: true,
    aiEnabled: true,
    rejectedEvidenceRefs: 0,
    truncated: false,
  };

  const text = (input: Parameters<typeof buildLimitations>[0]): string =>
    buildLimitations(input)
      .map((limitation) => `${limitation.ar}\n${limitation.en}`)
      .join("\n");

  test("always states that no project code is executed", () => {
    const limitation = buildLimitations(base).find((entry) => /no project code is executed/i.test(entry.en));
    assert.ok(limitation, "the 'no code is executed' limitation is mandatory");
    assert.ok(limitation.ar.includes("لا يُنفَّذ أي كود"), "and it is stated in Arabic too");
    assert.ok(
      buildLimitations({ ...base, advisoriesVerified: false, testsExecuted: false, aiEnabled: false }).some((entry) =>
        /no project code is executed/i.test(entry.en),
      ),
      "the mandatory limitation survives the other flags",
    );
  });

  test("adds each limitation exactly when its input says so", () => {
    assert.equal(buildLimitations(base).length, 2, "with everything verified only the two static limitations remain");

    const testsMissing = text({ ...base, testsExecuted: false });
    assert.ok(/no test was executed on our servers/i.test(testsMissing));
    assert.ok(!/advisory database could not be reached/i.test(testsMissing));

    const advisoriesMissing = text({ ...base, advisoriesVerified: false });
    assert.ok(/advisory database could not be reached/i.test(advisoriesMissing));
    assert.ok(!/AI explanation is not enabled/i.test(advisoriesMissing));

    const aiOff = text({ ...base, aiEnabled: false });
    assert.ok(/AI explanation is not enabled/i.test(aiOff));
    assert.ok(!/was truncated/i.test(aiOff));

    const truncated = text({ ...base, truncated: true });
    assert.ok(/truncated at the analysis limits/i.test(truncated));
    assert.ok(!/evidence references were rejected/i.test(truncated));
  });

  test("reports rejected evidence references with their count", () => {
    assert.ok(!/evidence references were rejected/i.test(text(base)), "no rejections, no limitation");
    const withRejections = text({ ...base, rejectedEvidenceRefs: 3 });
    assert.ok(withRejections.includes("3 evidence references were rejected"));
    assert.ok(buildLimitations({ ...base, rejectedEvidenceRefs: 3 }).some((entry) => entry.ar.includes("3")));
  });

  test("names every engine that did not complete cleanly", () => {
    const engines: EngineRunInfo[] = [
      { engine: "secrets", status: "ok", durationMs: 12, findings: 2, notes: [] },
      { engine: "api", status: "error", durationMs: 5, findings: 0, notes: [], error: "boom" },
      { engine: "architecture", status: "skipped", durationMs: 0, findings: 0, notes: ["no files"] },
    ];
    const enginesText = text({ ...base, engines });
    assert.ok(enginesText.includes("Engines that did not complete: api, architecture."));
    assert.ok(!enginesText.includes("secrets"), "an engine that finished is not listed");
    assert.equal(buildLimitations({ ...base, engines }).length, 3, "one extra limitation for the failed engines");
  });

  test("every limitation is bilingual and non-empty", () => {
    const limitations = buildLimitations({
      ...base,
      engines: [{ engine: "api", status: "error", durationMs: 1, findings: 0, notes: [], error: "x" }],
      advisoriesVerified: false,
      testsExecuted: false,
      aiEnabled: false,
      rejectedEvidenceRefs: 1,
      truncated: true,
    });
    assert.equal(limitations.length, 8, "each triggered limitation adds exactly one entry");
    for (const limitation of limitations) {
      assert.ok(limitation.ar.trim().length > 0, "missing Arabic text");
      assert.ok(limitation.en.trim().length > 0, "missing English text");
    }
  });
});
