/**
 * Shared rule helpers.
 *
 * The catalogue is split by category so a reviewer can read one file at a time; the order of
 * `RULE_CATALOG` (and therefore of every report) is fixed by `./index.ts`.
 */
import type { BilingualText, FindingCategory, EngineId, RuleDef, Severity } from "../../types";
import { RULE_CATALOG_VERSION } from "../../types";

export type Pair = [string, string];

export interface RuleInput {
  id: string;
  engine: EngineId;
  category: FindingCategory;
  severity: Severity;
  confidence: number;
  languages: string[] | "all";
  title: Pair;
  description: Pair;
  impact: Pair;
  recommendation: Pair;
  detection: Pair;
  references: string[];
}

export function def(input: RuleInput): RuleDef {
  const bi = (pair: Pair): BilingualText => ({ ar: pair[0], en: pair[1] });
  return {
    id: input.id,
    engine: input.engine,
    category: input.category,
    severity: input.severity,
    confidence: input.confidence,
    languages: input.languages,
    name: bi(input.title),
    description: bi(input.description),
    impact: bi(input.impact),
    recommendation: bi(input.recommendation),
    detection: bi(input.detection),
    references: input.references,
    version: RULE_CATALOG_VERSION,
  };
}
export const OWASP = "https://owasp.org/www-project-top-ten/";
export const CWE = (id: number) => `https://cwe.mitre.org/data/definitions/${id}.html`;
export const OSV = "https://osv.dev";

