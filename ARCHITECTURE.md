# Architecture

## One process, no hidden workers

The original specification asks for Redis queues and long-running workers. This deployment has neither:
the app runs as a single Next.js server that sleeps when idle, and there are no scheduled jobs.

The audit is therefore designed as a **short, bounded, self-contained run inside one HTTP request**,
streamed to the browser as newline-delimited JSON:

1. `POST /api/projects` (or `/api/projects/upload`) creates the project and a `QUEUED` audit job.
2. The audit page opens `POST /api/audits/{jobId}/run`.
3. `executeAudit()` walks the stages, **persisting each transition on the job row** and pushing the same
   event down the stream.
4. When the response ends, the run row holds the summary, statistics, limitations and engine report.

Consequences handled on purpose:

- Reloading the page mid-audit shows the persisted stage list instead of losing progress.
- A finished job returns its existing run rather than auditing twice (idempotent entry point).
- Everything is bounded: `ANALYSIS_LIMITS` caps files (4000), per-file size (400 KB), total text bytes
  (12 MB) and engine time (55 s), and each engine checks the deadline before starting more work.
- The advisory lookups (OSV) are cached in `registry_cache` for 7 days, so repeat audits are cheap.

## Stages and job states

```
QUEUED → CLONING → DETECTING → ANALYZING → SECURITY_SCAN → DEPENDENCY_SCAN → TESTING
       → ARCHITECTURE → AI_REVIEW → VERIFYING → REPORTING → COMPLETED
                                                          ↘ FAILED / CANCELLED
```

`ALLOWED_TRANSITIONS` in `lib/analysis/runner.ts` is enforced by the stage emitter, so no code path can
skip a stage or move backwards.

## Engines

| Engine | Input | Method | Output |
| --- | --- | --- | --- |
| stack | all files | manifest and file signals | languages, frameworks, package managers, test frameworks, CI, DB indicators |
| secrets | text files | provider patterns + entropy + context, values masked | findings with masked value, entropy, pattern name |
| security | text files | language-aware patterns, AST checks for JS/TS | injection, XSS, traversal, TLS, CORS, debug, logging findings |
| dependencies | manifests + lock files | parsing + OSV `querybatch` + advisory hydration | dependency rows, vulnerabilities with fixed versions |
| quality | text files | TypeScript AST (functions, complexity, nesting) + line metrics | metrics + threshold findings + duplication windows |
| architecture | imports | import graph, DFS cycle detection, coupling, layer rules | cycles, coupling, oversized modules, graph edges |
| api | route files | route + handler extraction for Next/Express/Laravel/FastAPI/Django | auth, validation, error leak, pagination findings |
| database | migrations, schemas | SQL, Prisma, Django, Laravel parsers | FK without index, missing unique, N+1, `SELECT *`, destructive migrations |
| ops | Dockerfile, compose, CI | text rules | root container, unpinned images, remote scripts, CI secrets |
| tests | test files + artifacts | framework detection, JUnit/lcov parsing | test runs (never executed), failing tests, coverage |

Engine failures are isolated: one engine raising an error marks itself `error` in the engine report and in
the audit limitations, while the rest of the audit completes.

## Evidence layer

`lib/analysis/evidence.ts`

- **Grounding**: a finding whose `filePath` is not in the analysed manifest is dropped and recorded as a
  rejected reference — engines cannot invent files either.
- **Masking**: every snippet passes through `scrubSecrets()` twice (engine + store), so a value detected
  on one line cannot leak through the context window of another finding.
- **Fingerprint**: `sha256(ruleId | path | symbol-or-line-content)`, stable across line shifts and
  changing when the code at the site changes. This is what makes comparison and false-positive
  decisions work across audits.
- **Deduplication**: same fingerprint → one finding, occurrences merged and kept in evidence metadata.

## Data model

`users`, `sessions`, `organizations`, `organization_members`, `login_attempts`, `projects`,
`repositories`, `project_sources`, `audit_jobs`, `audit_runs`, `findings`, `finding_evidence`,
`finding_events`, `finding_decisions`, `dependencies`, `vulnerabilities`, `test_runs`,
`architecture_nodes`, `architecture_edges`, `ai_reviews`, `reports`, `audit_policies`, `audit_events`,
`rules_catalog`, `registry_cache`.

Deleting a project cascades to every row above that belongs to it — that is the privacy promise, and it
is why no audit data is duplicated outside this database.

## Front end

Next.js App Router, server components for data, small client components only where interaction is needed
(audit streaming, forms, filters). Tailwind v4 with a token theme, logical CSS properties for RTL, and a
print stylesheet so the report page doubles as a PDF source. `GET /api/audits/{id}/report` returns the
same report as JSON for automation.

## Roadmap (V2+)

Pull-request mode via webhooks · incremental audits limited to changed files · AI patch suggestions with
approval before any commit · policy engine (PASS/FAIL gates) · Slack/email notifications ·
organisations with SSO and billing · self-hosted runners for test execution in a real sandbox.
