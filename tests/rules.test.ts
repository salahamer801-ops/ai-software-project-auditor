/**
 * Rule catalogue integrity (§46) — the regression net for the split of the catalogue into
 * `lib/rules/catalog/*`. A rule that loses a translation, an engine, a severity or its id
 * uniqueness breaks reports and the rules-engine explanations at once.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { apiRules } from "../lib/rules/catalog/06-api";
import { architectureRules } from "../lib/rules/catalog/05-architecture";
import { databaseRules } from "../lib/rules/catalog/07-database";
import { dependenciesRules } from "../lib/rules/catalog/03-dependencies";
import { qualityRules } from "../lib/rules/catalog/04-quality";
import { opsRules } from "../lib/rules/catalog/08-ops";
import { secretsRules } from "../lib/rules/catalog/01-secrets";
import { securityRules } from "../lib/rules/catalog/02-security";
import { testsRules } from "../lib/rules/catalog/09-tests";
import {
  getRule,
  RULES_BY_ID,
  RULE_CATALOG,
  RULE_SOURCES,
  SUPPORTED_LANGUAGES,
  ruleStats,
} from "../lib/rules/catalog";
// Imported through the project's `@/` alias on purpose: this is the one test file that
// exercises the alias arm of `tests/loader.mjs`, which every other module resolves
// extension-less instead.
import { CATEGORIES, ENGINES, SEVERITIES, type RuleDef } from "@/lib/types";

const BILINGUAL_FIELDS = ["name", "description", "impact", "recommendation", "detection"] as const;

/** The catalogue parts, in the order `RULE_CATALOG` concatenates them. */
const CATALOG_PARTS: { file: string; rules: RuleDef[] }[] = [
  { file: "01-secrets.ts", rules: secretsRules },
  { file: "02-security.ts", rules: securityRules },
  { file: "03-dependencies.ts", rules: dependenciesRules },
  { file: "04-quality.ts", rules: qualityRules },
  { file: "05-architecture.ts", rules: architectureRules },
  { file: "06-api.ts", rules: apiRules },
  { file: "07-database.ts", rules: databaseRules },
  { file: "08-ops.ts", rules: opsRules },
  { file: "09-tests.ts", rules: testsRules },
];

describe("rule catalogue", () => {
  test("is not empty and every part contributes rules", () => {
    assert.ok(RULE_CATALOG.length > 0, "the catalogue must contain at least one rule");
    for (const part of CATALOG_PARTS) {
      assert.ok(part.rules.length > 0, `${part.file} contributed no rules`);
    }
    assert.equal(
      CATALOG_PARTS.reduce((sum, part) => sum + part.rules.length, 0),
      RULE_CATALOG.length,
      "RULE_CATALOG must be exactly the concatenation of its parts",
    );
  });

  test("every rule id is unique", () => {
    const ids = RULE_CATALOG.map((rule) => rule.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate rule id in the catalogue");
    for (const id of ids) {
      assert.match(id, /^[A-Z]{3}-\d{3}$/, `unexpected rule id format: ${id}`);
    }
  });

  test("every rule carries a version, category, severity, engine and confidence", () => {
    for (const rule of RULE_CATALOG) {
      assert.equal(typeof rule.version, "string", `${rule.id}: version must be a string`);
      assert.ok(rule.version.trim().length > 0, `${rule.id}: version must not be empty`);
      assert.ok(CATEGORIES.includes(rule.category), `${rule.id}: unknown category ${rule.category}`);
      assert.ok(SEVERITIES.includes(rule.severity), `${rule.id}: unknown severity ${rule.severity}`);
      assert.ok(ENGINES.includes(rule.engine), `${rule.id}: unknown engine ${rule.engine}`);
      assert.ok(
        rule.confidence > 0 && rule.confidence <= 1,
        `${rule.id}: confidence must sit in (0, 1], got ${rule.confidence}`,
      );
      assert.ok(Array.isArray(rule.references), `${rule.id}: references must be an array`);
    }
  });

  test("the engine of a rule matches the category's owner", () => {
    // Each category is produced by the engine of the same name, except `security`, which is
    // split between the `secrets` and `security` engines (SEC-001..007 vs SEC-1xx).
    for (const rule of RULE_CATALOG) {
      if (rule.category === "security") {
        assert.ok(
          rule.engine === "security" || rule.engine === "secrets",
          `${rule.id}: security rules belong to the security or secrets engine, got ${rule.engine}`,
        );
        continue;
      }
      assert.equal(rule.engine, rule.category, `${rule.id}: engine should equal its category`);
    }
  });

  test("every rule is bilingual in all five text fields", () => {
    for (const rule of RULE_CATALOG) {
      for (const field of BILINGUAL_FIELDS) {
        const text = rule[field];
        assert.equal(typeof text?.ar, "string", `${rule.id}.${field}.ar missing`);
        assert.equal(typeof text?.en, "string", `${rule.id}.${field}.en missing`);
        assert.ok(text.ar.trim().length > 0, `${rule.id}.${field}.ar is empty`);
        assert.ok(text.en.trim().length > 0, `${rule.id}.${field}.en is empty`);
      }
    }
  });

  test("every rule declares a language scope", () => {
    for (const rule of RULE_CATALOG) {
      if (rule.languages === "all") continue;
      assert.ok(Array.isArray(rule.languages), `${rule.id}: languages must be "all" or an array`);
      assert.ok(rule.languages.length > 0, `${rule.id}: languages is an empty array — use "all" instead`);
      for (const language of rule.languages) {
        assert.equal(language, language.toLowerCase(), `${rule.id}: language ${language} should be lowercase`);
      }
    }
    assert.ok(
      RULE_CATALOG.some((rule) => rule.languages === "all"),
      "at least one rule is expected to apply to every language",
    );
    assert.ok(
      RULE_CATALOG.some((rule) => rule.languages !== "all"),
      "at least one rule is expected to be language-scoped",
    );
  });

  test("RULE_SOURCES totals equal the real catalogue length", () => {
    assert.equal(RULE_SOURCES.length, CATALOG_PARTS.length, "one RULE_SOURCES row per catalogue part");
    for (const [index, source] of RULE_SOURCES.entries()) {
      assert.equal(source.file, CATALOG_PARTS[index].file, `RULE_SOURCES order drifted at index ${index}`);
      assert.equal(
        source.rules,
        CATALOG_PARTS[index].rules.length,
        `${source.file}: RULE_SOURCES says ${source.rules} rules, the module exports ${CATALOG_PARTS[index].rules.length}`,
      );
    }
    assert.equal(
      RULE_SOURCES.reduce((sum, source) => sum + source.rules, 0),
      RULE_CATALOG.length,
      "RULE_SOURCES must add up to RULE_CATALOG.length",
    );
  });

  test("RULES_BY_ID and getRule agree with the array", () => {
    assert.equal(Object.keys(RULES_BY_ID).length, RULE_CATALOG.length, "RULES_BY_ID must index every rule, once");
    for (const rule of RULE_CATALOG) {
      assert.equal(RULES_BY_ID[rule.id], rule, `RULES_BY_ID[${rule.id}] is not the catalogue entry`);
      assert.equal(getRule(rule.id), rule, `getRule(${rule.id}) is not the catalogue entry`);
    }
    assert.equal(getRule("NOPE-000"), undefined, "an unknown id must not resolve to a rule");
  });

  test("SUPPORTED_LANGUAGES is sorted, unique and matches the rules", () => {
    assert.ok(SUPPORTED_LANGUAGES.length > 0, "SUPPORTED_LANGUAGES must not be empty");
    assert.deepEqual(
      SUPPORTED_LANGUAGES,
      [...SUPPORTED_LANGUAGES].sort(),
      "SUPPORTED_LANGUAGES must be sorted",
    );
    assert.equal(new Set(SUPPORTED_LANGUAGES).size, SUPPORTED_LANGUAGES.length, "duplicate language");
    const declared = new Set(
      RULE_CATALOG.flatMap((rule) => (rule.languages === "all" ? [] : rule.languages)),
    );
    assert.deepEqual(SUPPORTED_LANGUAGES, [...declared].sort(), "SUPPORTED_LANGUAGES must be derived from the rules");
  });

  test("ruleStats reports the same total and a category breakdown that adds up", () => {
    const stats = ruleStats();
    assert.equal(stats.total, RULE_CATALOG.length);
    assert.ok(stats.version.trim().length > 0, "the catalogue needs a version");
    const byCategoryTotal = Object.values(stats.byCategory).reduce((sum, count) => sum + count, 0);
    assert.equal(byCategoryTotal, RULE_CATALOG.length, "category counts must sum to the catalogue size");
    for (const category of CATEGORIES) {
      const expected = RULE_CATALOG.filter((rule) => rule.category === category).length;
      assert.equal(stats.byCategory[category] ?? 0, expected, `category ${category} count drifted`);
    }
  });
});
