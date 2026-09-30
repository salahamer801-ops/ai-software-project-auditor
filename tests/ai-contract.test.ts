/**
 * AI contract (§28–§29).
 *
 * The rules-engine path is the one that always runs (no provider, no network): it must still
 * produce a complete, labelled, evidence-grounded explanation, and it must never claim that
 * verification happened. The prompt definitions are versioned and carry an explicit output
 * contract, which is what makes an AI result reviewable after the fact.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { explainFindingWithRules } from "../lib/ai/reviewer";
import {
  ARCHITECTURE_REVIEW_PROMPT,
  codeContextFor,
  FINDING_EXPLANATION_PROMPT,
  projectContextFor,
  REPORT_SUMMARY_PROMPT,
} from "../lib/ai/prompts";
import { findingOf, snapshotOf, demoSecret } from "./helpers";

const SECRET = demoSecret("sk", "live", "abcdef1234567890abcdef");

const snapshot = snapshotOf([
  { path: "src/a.ts", content: `const apiKey = '${SECRET}';\nexport const b = 1;\n` },
  { path: "src/b.ts", content: "export const c = 2;\n" },
  { path: "package.json", content: JSON.stringify({ dependencies: { next: "15.5.26" } }) },
]);

const finding = findingOf(
  { ruleId: "SEC-001", filePath: "src/a.ts", lineStart: 1, snippet: `const apiKey = '${SECRET}';` },
  snapshot,
);

const known = new Set(snapshot.files.map((file) => file.path));

describe("rules-engine explanation", () => {
  test("is labelled as a rules-engine answer, never as AI", () => {
    const explanation = explainFindingWithRules(finding);
    assert.equal(explanation.source, "rules_engine");
    assert.equal(explanation.model, null, "no model was involved");
    assert.ok(explanation.promptVersion.trim().length > 0, "the rules path is versioned too");
    assert.ok(
      explanation.limitations.some((line) => /rules engine, not by a language model/i.test(line)),
      "the explanation says where it came from",
    );
    assert.ok(
      explanation.limitations.some((line) => /no dynamic execution/i.test(line)),
      "the explanation repeats that nothing was executed",
    );
  });

  test("carries a confidence inside 0..1", () => {
    const explanation = explainFindingWithRules(finding);
    assert.ok(explanation.confidence >= 0 && explanation.confidence <= 1, `confidence out of range: ${explanation.confidence}`);
    assert.equal(explanation.confidence, finding.confidence, "the explanation inherits the detection confidence");
  });

  test("only references files that exist in the analysed snapshot", () => {
    const explanation = explainFindingWithRules(finding);
    assert.ok(explanation.evidenceRefs.length > 0, "the finding has a file, so there is a reference");
    for (const ref of explanation.evidenceRefs) {
      assert.ok(known.has(ref.file), `${ref.file} is not part of the analysed snapshot`);
    }
    assert.deepEqual(explanation.evidenceRefs, [{ file: "src/a.ts", line: 1 }]);
  });

  test("claims no verification and rejects nothing", () => {
    const explanation = explainFindingWithRules(finding);
    assert.equal(explanation.verificationOccurred, false, "the rules engine verifies nothing");
    assert.deepEqual(explanation.rejectedEvidenceRefs, []);
  });

  test("answers bilingually in every text field", () => {
    const explanation = explainFindingWithRules(finding);
    for (const [name, text] of Object.entries({
      explanation: explanation.explanation,
      practicalImpact: explanation.practicalImpact,
      remediation: explanation.remediation,
      falsePositiveIndicators: explanation.falsePositiveIndicators,
    })) {
      assert.ok(text.ar.trim().length > 0, `${name} is missing Arabic`);
      assert.ok(text.en.trim().length > 0, `${name} is missing English`);
    }
  });

  test("quotes the finding, its location and its evidence", () => {
    const explanation = explainFindingWithRules(finding);
    assert.ok(explanation.explanation.en.includes(finding.description.en), "the rule description is quoted");
    assert.ok(explanation.explanation.en.includes("src/a.ts:1"), "the location is stated");
    assert.ok(explanation.explanation.ar.includes("src/a.ts:1"), "the location is stated in Arabic too");
    assert.ok(explanation.explanation.en.includes(finding.detectionMethod.en), "the detection method is stated");
    assert.ok(explanation.remediation.en.includes(finding.recommendation.en), "the recommendation is quoted");
    assert.ok(explanation.remediation.en.includes("re-run the audit"), "the remediation says how to confirm the fix");
    assert.ok(/critical|high|medium|low|informational/i.test(explanation.practicalImpact.en), "the severity is stated");
  });

  test("a finding with no file still produces a complete explanation", () => {
    const fileLess = { ...finding, filePath: null, lineStart: null, lineEnd: null, evidence: [] };
    const explanation = explainFindingWithRules(fileLess);
    assert.deepEqual(explanation.evidenceRefs, [], "no file means no reference");
    assert.equal(explanation.source, "rules_engine");
    assert.ok(explanation.explanation.en.includes("the project"), "the location falls back to the project");
    assert.ok(explanation.explanation.en.includes("No additional evidence was recorded."));
    assert.ok(explanation.remediation.en.length > 0);
  });

  test("mentions the advisories and the occurrence count when the finding carries them", () => {
    const dependencyFinding = findingOf(
      { ruleId: "DEP-003", filePath: "package.json", lineStart: 1, snippet: "next: 15.0.0 → 15.5.26" },
      snapshot,
    );
    const withAdvisory = {
      ...dependencyFinding,
      metadata: {
        ...dependencyFinding.metadata,
        occurrences: 3,
        advisories: [{ id: "GHSA-xxxx", fixedVersion: "15.5.26", severity: "HIGH" }],
      },
    };
    const explanation = explainFindingWithRules(withAdvisory);
    assert.ok(explanation.explanation.en.includes("GHSA-xxxx"), "the advisory id is quoted");
    assert.ok(explanation.explanation.en.includes("fixed in 15.5.26"), "the fixed version is quoted");
    assert.ok(explanation.explanation.en.includes("appears 3 times"), "the grouped occurrences are explained");
    assert.ok(explanation.explanation.ar.includes("GHSA-xxxx"), "the Arabic text carries the advisory too");
  });

  test("a test-path finding says so and gets the category hint", () => {
    const testFinding = findingOf(
      { ruleId: "QUA-001", filePath: "tests/a.test.ts", lineStart: 1, snippet: "long function" },
      snapshotOf([{ path: "tests/a.test.ts", content: "function a() {}\n" }]),
    );
    const explanation = explainFindingWithRules(testFinding);
    assert.ok(explanation.explanation.en.includes("inside a test path"), "the test path is mentioned");
    assert.ok(
      explanation.falsePositiveIndicators.en.includes("heuristic"),
      "the quality-category false-positive hint is used",
    );
  });

  test("the false-positive hint matches the finding category", () => {
    assert.ok(
      explainFindingWithRules(finding).falsePositiveIndicators.en.includes("environment variable"),
      "a secret finding gets the secrets hint",
    );
    const dependencyFinding = findingOf(
      { ruleId: "DEP-003", filePath: "package.json", lineStart: 1, snippet: "outdated" },
      snapshot,
    );
    assert.ok(
      explainFindingWithRules(dependencyFinding).falsePositiveIndicators.en.includes("production path"),
      "a dependency finding gets the dependencies hint",
    );
  });
});

describe("prompt definitions", () => {
  const prompts: { id: string; version: string; system: string; outputContract: string; buildUser: unknown }[] = [
    FINDING_EXPLANATION_PROMPT,
    REPORT_SUMMARY_PROMPT,
    ARCHITECTURE_REVIEW_PROMPT,
  ];

  const explanationPrompts: { id: string; outputContract: string }[] = [
    FINDING_EXPLANATION_PROMPT,
    ARCHITECTURE_REVIEW_PROMPT,
  ];

  test("every prompt declares an id, a version and a system instruction", () => {
    for (const prompt of prompts) {
      assert.ok(prompt.id.trim().length > 0, "a prompt needs an id");
      assert.ok(prompt.version.trim().length > 0, `${prompt.id}: a prompt needs a version`);
      assert.ok(prompt.system.trim().length > 0, `${prompt.id}: missing system instruction`);
      assert.equal(typeof prompt.buildUser, "function", `${prompt.id}: missing payload builder`);
    }
  });

  test("every prompt declares a non-empty, bilingual output contract", () => {
    for (const prompt of prompts) {
      assert.ok(prompt.outputContract.trim().length > 0, `${prompt.id}: empty output contract`);
      assert.match(prompt.outputContract, /"ar"/, `${prompt.id}: the contract must ask for Arabic text`);
      assert.match(prompt.outputContract, /"en"/, `${prompt.id}: the contract must ask for English text`);
      assert.match(prompt.system, /JSON only/i, `${prompt.id}: the grounding rules must require JSON`);
      assert.match(prompt.system, /Never invent/i, `${prompt.id}: the grounding rules must forbid invention`);
      assert.match(prompt.system, /Only reference files and line numbers/i, `${prompt.id}: the grounding rules must bound the model`);
    }
  });

  test("the explanation contracts demand a confidence and evidence references", () => {
    for (const prompt of explanationPrompts) {
      assert.match(prompt.outputContract, /"confidence"\s*:\s*number/, `${prompt.id}: no confidence in the contract`);
      assert.match(prompt.outputContract, /"evidenceRefs"/, `${prompt.id}: no evidence references in the contract`);
      assert.match(prompt.outputContract, /"limitations"/, `${prompt.id}: no limitations field in the contract`);
      assert.match(prompt.outputContract, /"falsePositiveIndicators"/, `${prompt.id}: no false-positive field`);
    }
  });

  test("the report-summary contract forbids inventing findings or a score", () => {
    assert.match(REPORT_SUMMARY_PROMPT.outputContract, /"headline"/);
    assert.match(REPORT_SUMMARY_PROMPT.outputContract, /"highlights"/);
    assert.match(REPORT_SUMMARY_PROMPT.outputContract, /"findingId"/, "a highlight must be tied to a real finding");
    assert.match(REPORT_SUMMARY_PROMPT.system, /never produce a single "score"/i);
    assert.ok(
      !/"confidence"\s*:\s*number/.test(REPORT_SUMMARY_PROMPT.outputContract),
      "the summary must not invent a confidence score",
    );
  });

  test("prompt versions are unique per prompt definition", () => {
    // The app versions a prompt as `id@version` (reviewer.ts), and today all three prompts
    // are at v1 — so it is the id+version pair that must be unique, and the version string
    // alone is not a discriminator. A changed prompt must use a new pair.
    const refs = prompts.map((prompt) => `${prompt.id}@${prompt.version}`);
    assert.equal(new Set(refs).size, refs.length, `duplicate prompt version: ${refs.join(", ")}`);
    assert.equal(new Set(prompts.map((prompt) => prompt.id)).size, prompts.length, "duplicate prompt id");
  });

  test("the finding-explanation payload grounds the model in the evidence", () => {
    const user = FINDING_EXPLANATION_PROMPT.buildUser({
      finding,
      codeContext: "1: const apiKey = 'sk_live_********';",
      relatedFiles: snapshot.files.map((file) => file.path),
      projectContext: projectContextFor(snapshot),
    });
    assert.ok(user.includes(finding.ruleId), "the rule id is part of the payload");
    assert.ok(user.includes("src/a.ts"), "the location is part of the payload");
    assert.ok(user.includes("Related files you may reference"), "the payload lists the manifest it may cite");
    for (const file of snapshot.files) {
      assert.ok(user.includes(file.path), `${file.path} is missing from the allowed-file list`);
    }
    assert.ok(!user.includes(SECRET), "the payload must never carry the raw secret");
  });

  test("projectContextFor and codeContextFor describe the audit honestly", () => {
    const context = projectContextFor(snapshot);
    assert.ok(context.includes("files analysed: 3 of 3"));
    assert.ok(context.includes("frameworks: Next.js"));
    assert.ok(context.includes("package managers: npm"));
    assert.ok(context.includes("test frameworks: none detected"));
    assert.ok(context.includes("docker: no"));

    const codeContext = codeContextFor(finding, snapshot.files.find((file) => file.path === "src/a.ts")?.content, 2);
    assert.ok(codeContext.includes("1: "), "code context is line-numbered");
    assert.ok(codeContext.startsWith("1: const apiKey"), "the numbered range starts at the first line");
    assert.equal(
      codeContextFor(finding, undefined),
      "(no code context available)",
      "a missing file content must be stated, not invented",
    );
  });

  test("the code context sent to a model is masked", () => {
    // §17/§29: the prompt labels the block "(masked, …)" and promises that the value the model
    // sees is already masked — so no raw credential may reach the payload. Regression: the
    // context used to be raw file content.
    const rawContent = snapshot.files.find((file) => file.path === "src/a.ts")?.content;
    assert.ok(rawContent, "the fixture file has content");
    const context = codeContextFor(finding, rawContent, 2);

    assert.ok(!context.includes(SECRET), "the whole credential is gone");
    assert.ok(!context.includes(SECRET.slice(7)), "and so is the secret material after the prefix");
    assert.ok(context.includes("apiKey"), "while the line the finding is about is still visible");

    const user = FINDING_EXPLANATION_PROMPT.buildUser({
      finding,
      codeContext: context,
      relatedFiles: snapshot.files.map((file) => file.path),
      projectContext: projectContextFor(snapshot),
    });
    assert.ok(user.includes("Code context (masked"), "the payload says the context is masked");
    assert.ok(!user.includes(SECRET), "…and that is now true");
  });
});
