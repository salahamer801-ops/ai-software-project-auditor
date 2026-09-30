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

`ALLOWED_TRANSITIONS` in `lib/analysis/state.ts` is enforced by the stage emitter, so no code path can
skip a stage or move backwards. `tests/state.test.ts` proves the graph: every state can reach `COMPLETED`,
`FAILED` and `CANCELLED`, the terminal states go nowhere, and a jump such as `QUEUED → TESTING` is refused.

## Pipeline modules

`executeAudit()` is the orchestrator and nothing else — it owns the order of the stages, the job state and
the failure path. Each stage is its own module, so a stage can be read, reviewed and tested alone:

```
lib/analysis/
  runner.ts              order, job state, cancellation, failure handling
  state.ts               STAGE_LABEL, ALLOWED_TRANSITIONS, StageEmitter, isCancelled
  source.ts              the manifest: demo / GitHub tarball / uploaded archive
  evidence.ts            normalisation, grounding, masking, fingerprints
  summary.ts             verdict, counts, limitations
  stages/engines.ts      the ten deterministic engines
  stages/ai.ts           explanatory review + audit summary (bounded, evidence-verified)
  stages/persist.ts      the audit as one immutable record, in one transaction
```

The rule catalogue is likewise split by category (`lib/rules/catalog/01-secrets.ts` … `09-tests.ts`) with
`index.ts` fixing the order — the order is part of the report, so it is explicit rather than incidental.

## Migrations

`lib/db/migrations/` holds ordered, immutable migrations; `lib/db/migrate.ts` is the runner. It runs from
`ensureSchema()` on the first query of a process, which suits a host that boots on the first request:

- one cheap table check when nothing is pending, each migration in its own transaction otherwise;
- a session-level advisory lock, so two instances booting together cannot apply the same migration twice;
- a checksum per applied migration: editing an old migration is reported as drift (logged, surfaced in
  diagnostics) rather than silently diverging the schema.

Adding a migration means adding a file and registering it in `lib/db/migrations/index.ts`. Migrations are
never edited after they have been applied anywhere.

## Observability

`lib/observability/log.ts` writes one JSON line per event (`ts`, `level`, `event`, fields) to stdout and
never throws. Keys that look like credentials, tokens, cookies or passwords are replaced with
`[redacted]`, long strings and arrays are truncated, and errors are reduced to `{ name, message }` — a
stack never reaches a log line or a response body.

What is logged, and why it is enough to reconstruct a run: `api.request` / `api.response` with status and
duration per route, `audit.stage` per transition, `audit.engine` per engine with status and duration,
`audit.ai.*` for the explanatory layer, `audit.persisted` with the verdict, `audit.failed` with the stage
it failed in, plus `db.migration.*` and the pool's retry path.

## API errors and validation

Every route handler is wrapped by `withRoute()` (`lib/api/route.ts`):

- a request id per call (reusing an incoming `x-request-id`), echoed on the response and in the log line;
- typed `ApiError`s (`httpError(status, code, message, details)`) from the route or from the validators
  (`str`, `oneOf`, `int`, `email`) and `readJson()` (415/413/400 on content type, size, parse);
- known domain errors mapped to their own status (`ArchiveError` → 400, `GithubError` → 502 or its own),
  anything unexpected → 500 with a generic message; the real error text goes to the log only.

The response contract is `{ error: <code>, code, message, requestId, details? }` — the UI matches on the
code, the human text is bilingual, and no database or stack message is ever returned to a client.

## Tests

`npm test` runs 155 tests on Node's built-in runner — no test framework, no network, no database, no server.
The suite covers the rule catalogue's integrity, the state machine, fingerprint stability and evidence
grounding, secret masking end to end (a finding may never carry an unmasked value), archive intake against
path traversal, symlinks and budgets, manifest parsing, stack detection, summary/limitations, migration
checksums, the AI output contract, and repository-address validation. Six real defects were found and fixed
this way (see `CHANGELOG.md`).

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

## Execution sandbox

Execution is the one place where code from the audited project runs, so it is opt-in, bounded and
described in the report rather than trusted.

**What may run.** A file qualifies only if it is a test file (by path), imports `node:test` explicitly, and
imports nothing that would have to be installed — checked through its relative imports as well
(`lib/sandbox/candidates.ts`). Everything else is skipped *with a reason code* that the UI and the report
translate, because running a Jest suite without Jest would produce failures caused by the harness.

**How it runs.** One child process per file (`lib/sandbox/run.ts`):

| Layer | Enforced by | Effect |
| --- | --- | --- |
| `--permission`, `--allow-fs-read=<workspace>` | Node runtime | no filesystem writes, no `child_process`, no workers, no native addons, no `process.binding` |
| `--import` of the guard (`lib/sandbox/guard.ts`) | our own code | `fetch`, `WebSocket`, `net`/`tls`/`dgram` sockets, `dns`, `http(s)`, `http2` throw before project code loads |
| `--max-old-space-size` + SIGKILL at the per-file deadline | Node runtime | memory and time bounds, plus a wall budget for the whole phase |
| Rebuilt environment (`HOME`/`TMPDIR` = workspace, nothing else) | the parent process | no `DATABASE_URL`, no tokens, no host paths |
| A temporary workspace, removed in `finally` | the parent process | audited files never persist on the host |

**What comes back.** Counts from the runner's own TAP summary, case-level results parsed from TAP
(`lib/sandbox/tap.ts`), the *assertion's* file and line (mapped back from the temporary path), messages
passed through the secret masker, the limits the run executed under, and the list of files that did not
run. `lib/engines/execution.ts` turns failing cases into `TST-006` findings, load failures into `TST-007`
and deadlines into `TST-008` — capped at ten case findings, with totals kept in the run record.

**What it is not.** Not a container, not a hypervisor, not OS-level isolation. A process that ignores the
patched entry points (a native addon, or an ESM named binding for the few guards with no prototype hook)
is beyond what an in-process guard can do. That sentence ships in every report that contains an executed
run.

## Roadmap

The plan is deliberately ordered so the evidence-first architecture (§67) survives every addition: a tool
detects, evidence proves, AI explains, verification confirms.

| Stage | Content |
| --- | --- |
| **V1 — Repository audit** | done: deterministic engines, evidence layer, explanatory AI, report, history, comparison, false-positive decisions |
| **V1.1 — Engineering hardening** | done: migrations, automated tests, error handling and validation, observability, split modules, security hardening |
| **V1.2 — Restricted execution sandbox** | this release: real `node:test` execution in a permission-limited child process with network guards, scrubbed environment, wall/per-file/memory limits, and case-level evidence — opt-in per audit |
| **V2 — Isolated execution** | container-level isolation, dependency install, build verification, disk limits, network off by default — what the in-process sandbox explicitly does not claim to be |
| **V3 — GitHub PR auditor** | webhooks, changed-files analysis, PR comments, status checks, policy gates (PASS/FAIL) |
| **V4 — AI fix engine** | patch generation, apply to a temporary branch, run tests, re-audit, show a verified diff — never a push without approval |
| **V5 — Team/global SaaS** | organisations, seats, billing, notifications, self-hosted runners, enterprise SSO |

What is intentionally *not* built yet: anything that needs a queue, a scheduler or a long-lived process —
the host sleeps between requests and there are no scheduled jobs, so containerised execution starts with
that problem. Until then, isolation is in-process and the report says so.
