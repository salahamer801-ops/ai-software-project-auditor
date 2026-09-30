import type { RuleDef } from "../../types";
import { RULE_CATALOG_VERSION } from "../../types";
import { secretsRules } from "./01-secrets";
import { securityRules } from "./02-security";
import { dependenciesRules } from "./03-dependencies";
import { qualityRules } from "./04-quality";
import { architectureRules } from "./05-architecture";
import { apiRules } from "./06-api";
import { databaseRules } from "./07-database";
import { opsRules } from "./08-ops";
import { testsRules } from "./09-tests";

export const RULE_CATALOG: RuleDef[] = [
  ...secretsRules,
  ...securityRules,
  ...dependenciesRules,
  ...qualityRules,
  ...architectureRules,
  ...apiRules,
  ...databaseRules,
  ...opsRules,
  ...testsRules,
];

/** Which file each part of the catalogue came from — used by diagnostics and tests. */
export const RULE_SOURCES: { file: string; rules: number }[] = [
  { file: "01-secrets.ts", rules: secretsRules.length },
  { file: "02-security.ts", rules: securityRules.length },
  { file: "03-dependencies.ts", rules: dependenciesRules.length },
  { file: "04-quality.ts", rules: qualityRules.length },
  { file: "05-architecture.ts", rules: architectureRules.length },
  { file: "06-api.ts", rules: apiRules.length },
  { file: "07-database.ts", rules: databaseRules.length },
  { file: "08-ops.ts", rules: opsRules.length },
  { file: "09-tests.ts", rules: testsRules.length },
];

export const RULES_BY_ID: Record<string, RuleDef> = Object.fromEntries(
  RULE_CATALOG.map((rule) => [rule.id, rule]),
);

export function getRule(id: string): RuleDef | undefined {
  return RULES_BY_ID[id];
}

export function ruleStats() {
  return {
    total: RULE_CATALOG.length,
    version: RULE_CATALOG_VERSION,
    byCategory: RULE_CATALOG.reduce<Record<string, number>>((acc, rule) => {
      acc[rule.category] = (acc[rule.category] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

export const SUPPORTED_LANGUAGES = Array.from(
  new Set(RULE_CATALOG.flatMap((rule) => (rule.languages === "all" ? [] : rule.languages))),
).sort();
