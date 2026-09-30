# Changelog

All notable changes to CodeAudit are recorded here. Versions follow the roadmap in `ARCHITECTURE.md`
(V1 repository audit → V1.1 engineering hardening → V2 execution sandbox → …).

## 1.1.0 — Engineering hardening

Hardening pass over V1: the behaviour a reviewer depends on is now enforced by migrations, tests and a
single error/logging contract instead of by convention.

### Added

- **Versioned migrations** (`lib/db/migrations/`, runner in `lib/db/migrate.ts`): ordered immutable
  migrations applied on the first query of a process, each in its own transaction, guarded by an advisory
  lock so two instances booting together cannot apply the same migration twice, with a checksum per
  applied migration so an edit to an old migration is reported as drift.
- **Automated test suite** — `npm test`, 155 tests on Node's built-in runner with no new dependencies, no
  network, no database and no server. Covers the rule catalogue, the job state machine, fingerprints and
  evidence grounding, secret masking end to end, archive intake (traversal, symlinks, budgets), manifest
  parsing, stack detection, summary and limitations, migration checksums, the AI output contract and
  repository-address validation.
- **Structured logging** (`lib/observability/log.ts`): one JSON line per event with redaction of
  credential-like keys, truncation of long values, and errors reduced to name and message. Request,
  stage, engine, AI, migration and failure events carry enough context to reconstruct a run.
- **One error and validation contract for the API** (`lib/api/route.ts`): every route runs through
  `withRoute()`, gets a request id echoed to the client and the log, and returns
  `{ error: <code>, code, message, requestId, details? }`. Input validation helpers and `readJson()`
  answer 400/413/415; known domain errors keep their status (archive 400, GitHub 502); anything unexpected
  becomes a 500 with a generic message and the real error only in the log.
- **Error and not-found pages** in Arabic and English, with a retry action and no leaked detail.
- **Diagnostics for migrations**: applied, pending and drifted migrations are readable without applying
  anything.
- **`CHANGELOG.md`** (required by the specification) and a documented roadmap through V5.

### Changed

- `lib/analysis/runner.ts` (760 lines) is now the orchestrator only; the stages live in
  `lib/analysis/state.ts`, `source.ts`, `stages/engines.ts`, `stages/ai.ts` and `stages/persist.ts`.
- The rule catalogue is split by category (`lib/rules/catalog/01-secrets.ts` … `09-tests.ts`) with the
  order fixed explicitly in `index.ts`; the extracted rules are byte-identical to the single file.
- Security headers: HSTS, `Cross-Origin-Opener-Policy`, `X-DNS-Prefetch-Control`,
  `X-Permitted-Cross-Domain-Policies`, a narrowed `Permissions-Policy`, and a production-only content
  security policy (the dev server needs eval for hot reload, which is why it is not applied there).

### Fixed

Six defects the new test suite exposed. All six were rewritten as regression tests.

- **The code context sent to an AI provider was not masked.** `codeContextFor` returned raw file lines
  while the prompt stated the context was masked, so a configured provider would have received the raw
  credential of a secret finding. Context lines now pass through `scrubSecrets()`.
- **A modern `package-lock.json` reported no dependencies.** The parser skipped every key starting with
  `node_modules/`, which is exactly how npm v2/v3 name their packages. It now skips the workspace root and
  local workspace entries instead, and reads nested packages and scopes correctly.
- **A hostile archive entry could be rewritten into a harmless-looking path.** The GitHub wrapper
  heuristic could nominate `..` as the prefix, turning `../evil.ts` into `evil.ts`. Escaping entries are
  now dropped before any prefix handling, and the wrapper candidate must look like a real repository
  folder.
- **A bracketed extra truncated a PEP 621 dependency list** (`psycopg[binary]` ended the array, dropping
  that entry and every entry after it). The array is now read by matching brackets and ignoring the ones
  inside quoted strings.
- **A single-line `require` in `go.mod` was never read** — the form `go mod tidy` writes when adding one
  module. The keyword is now stripped before matching, covering both spellings.
- **`your-api-key` was not recognised as a placeholder**, so documentation examples produced secret
  findings. The placeholder pattern accepts the hyphenated shape as well.

### Security notes

- Repository addresses are validated against GitHub's own naming rules and percent-encoded before they
  reach a URL path, so no input can address a different endpoint with the platform's token (SSRF).
- Session cookies are `httpOnly`, `SameSite=Lax`, `Secure` in production, and session tokens are stored
  as hashes; login and registration are rate limited.

## 1.0.0 — V1 repository audit

Deterministic engines (stack, secrets, security, dependencies via OSV, quality, architecture, API,
database, Docker/CI, committed test artifacts) into an evidence layer with stable fingerprints and
severity, an optional explanatory AI layer with schema validation and reference verification, an
HTML/JSON report, audit history and audit-to-audit comparison, false-positive decisions that survive
later audits, and a bilingual Arabic/English interface. Project code is never executed.
