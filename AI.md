# AI layer

The AI layer is **explanatory only**. It never decides whether a finding exists — the deterministic
engines do that — and it never sees the whole repository.

## Provider abstraction

`lib/ai/provider.ts` speaks the OpenAI-compatible chat-completions format, so any compatible endpoint
works:

| Variable | Meaning |
| --- | --- |
| `AI_API_KEY` (or `OPENAI_API_KEY`) | provider key; without it the layer is disabled |
| `AI_BASE_URL` | base URL, default `https://api.openai.com/v1` |
| `AI_MODEL` | model name, default `gpt-4o-mini` |
| `AI_MAX_FINDINGS` | how many findings receive an explanation per audit (default 8, cap 12) |

Nothing in the product imports a vendor SDK, so switching provider is configuration, not code.

## Prompts

Prompts live in `lib/ai/prompts.ts`, each with an id, a version, a system prompt, an explicit JSON output
contract, and a payload builder:

| Prompt id | Version | Purpose |
| --- | --- | --- |
| `finding-explanation` | v1 | explain one finding, its impact, the fix and false-positive indicators |
| `report-summary` | v1 | headline plus up to six highlights for the audit report |
| `architecture-review` | v1 | interpret cycles, coupling and layer violations |

The version actually used is stored on every review (`ai_reviews.prompt_version`), so a report can always
say which prompt produced its wording. Prompt tests assert that each prompt has an id, a version and a
JSON contract (`about.diagnostics` in the app).

## Guardrails, enforced in code

1. **Structured output**: the response must parse as JSON matching the contract; partial answers fall back
   to the rules-engine text.
2. **Evidence grounding**: every `{file, line}` the model returns is checked against the analysed
   manifest (`lib/ai/evidence-links.ts`). Unknown files, out-of-range lines and missing fields are
   rejected and stored in `rejected_evidence_refs`, and the count is surfaced in the UI, the report and
   the audit limitations.
3. **Minimal context**: the model receives the rule, the masked snippet, a small code window around the
   finding and general project facts. Never a full file tree of contents, never a raw secret.
4. **No invented artefacts**: identifiers referenced in a summary (`findingId`) must exist in the run;
   unknown ones are dropped rather than displayed.
5. **`verification_occurred`** is set to true only when at least one reference survived verification —
   otherwise the UI shows "not verified".
6. **Failures are visible**: a provider error is recorded in the explanation's limitations and the
   fallback text is used; the audit itself never fails because of the AI layer.

## Without a provider

`explainFindingWithRules()` produces the same interface from the rule catalogue plus the finding's
metadata: location, detection method, measured values (lines, complexity, advisories with fixed
versions), duplicate-occurrence counts, and category-specific false-positive hints. The result is labelled
`source: rules_engine` and shown with the badge "Explanation from the rules engine (no AI provider
configured)". The report and the JSON export carry the same label.

## What the AI is not allowed to do

- invent files, lines, vulnerabilities or tool runs;
- claim a test was executed (nothing is executed, ever);
- claim a fix without a patch (fix suggestions are V2 and require approval);
- reveal a secret — masked input is all it receives;
- produce a general "score" for a project: severity counts come from findings, not from prose.
