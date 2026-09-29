# CodeAudit — AI Software Project Auditor

A platform that audits software projects and produces a **traceable, evidence-backed report**:
deterministic analysis first, an explanatory AI layer second — never the other way round.

> The product never says "AI thinks your project is bad". It says: here is a specific finding,
> here is its evidence, here are the affected files, here is the explanation, here is the suggested
> fix, here are the tools that ran, and here is what was **not** verified.

## The path

```
Repository / archive → deterministic engines → evidence layer (fingerprint, severity, masking)
→ explanatory AI review (optional) → reference verification → report & comparison → history
```

## What it does today (V1)

- **Sign-up / sign-in** with scrypt password hashing, cookie sessions in the database, rate limiting,
  and an instant demo session (no email needed).
- **Source ingestion**: a public GitHub repository (or a private one with a read-only token via
  `GITHUB_TOKEN`), or an uploaded `ZIP` / `tar.gz`. Archives are parsed as **data** — never executed.
- **Stack detection** from manifests and files, never from a folder name.
- **Ten deterministic engines**: stack, secrets, security, dependencies (OSV), quality, architecture,
  API, database, Docker/CI, tests.
- **Evidence layer**: one rule per finding, file + line, masked evidence snippet, stable fingerprint,
  deduplication, severity from the rule or the advisory, and detection confidence.
- **Explanatory AI** (optional): specialised versioned prompts produce structured JSON per finding plus
  an audit summary. Without a provider key the same interface is served by the rules engine and labelled
  as such in the UI and the report.
- **Verification**: every file/line an AI refers to is checked against the analysed manifest; rejected
  references are recorded and shown.
- **Report + comparison**: printable HTML report, JSON export, and audit-to-audit comparison
  (resolved / new / unchanged / reopened) over an append-only history.
- **False-positive management**: a decision is stored per fingerprint and re-applied in later audits;
  nothing is ever deleted from history.
- **Bilingual UI**: Arabic (RTL, default) and English, with a keyboard-accessible, responsive layout.

## What it deliberately does not do (V1)

- It **never executes project code**: no dependency install, no test run, no image build, no sandbox
  escape surface. This is stricter than the original specification and is stated in every report.
- Test numbers come from **result files committed with the project** (JUnit XML, `coverage-summary.json`,
  `lcov.info`); otherwise the report says the state is unknown.
- No pull-request review, no automatic dependency updates, no automatic code fixes, no penetration
  testing, no requests to external systems. See `ARCHITECTURE.md` for the roadmap.

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build (standalone output)
npm run typecheck  # strict TypeScript check
```

Environment (provisioned by the platform, no manual setup):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection (schema is created automatically on first use) |
| `GITHUB_TOKEN` | optional read-only token for private repositories |
| `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` | optional OpenAI-compatible provider |
| `AI_MAX_FINDINGS` | how many findings get an AI explanation per audit (default 8) |
| `MYTHEX_WEB_ORIGIN` | canonical origin when one is needed (CORS, absolute links) |

The schema is created with `create table if not exists` at first query, so a cold start never needs a
migration step.

## Verifying the claims

Open **How it works → Engine self-tests** in the app. It runs real assertions against the same engines on
an intentionally flawed fixture (secret masking, fingerprint stability, cycle detection, archive path
traversal, OSV parsing, prompt contracts…). The demo repository button runs the full pipeline on that
fixture, and the whole audit is reproducible in the UI.

## Docs

- `ARCHITECTURE.md` — pipeline, engines, data model, why the audit runs inside a request.
- `SECURITY.md` — threat model and the rules the platform enforces on untrusted input.
- `RULES.md` — the rule catalogue and how a rule is written.
- `AI.md` — provider abstraction, prompts, guardrails and grounding.
