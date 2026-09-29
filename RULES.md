# Rule catalogue

Every rule is versioned (`RULE_CATALOG_VERSION`), bilingual (Arabic/English) and carries: id, name,
category, severity, confidence, languages, detection method, description, impact, recommendation and
references. The live catalogue is rendered in the app under **How it works → Rule catalogue**, and a
snapshot is stored per audit in `rules_catalog` so a report always shows the rules that produced it.

Writing a new rule means adding one entry to `lib/rules/catalog.ts` and one detector path in the engine
that owns the category. A rule without evidence is not accepted: the evidence layer drops any finding
whose file is not in the analysed manifest.

## Secrets (`engine: secrets`)

| ID | Severity | Detects |
| --- | --- | --- |
| SEC-001 | HIGH | hardcoded credential / API key in source |
| SEC-002 | CRITICAL | private key committed |
| SEC-003 | HIGH | access token literal (GitHub, Slack, JWT, Bearer) |
| SEC-004 | HIGH | a real `.env`-style secrets file committed |
| SEC-005 | MEDIUM | high-entropy literal assigned to a secret-looking variable |
| SEC-006 | HIGH | database URL containing credentials |
| SEC-007 | HIGH | credentials embedded in a URL (`scheme://user:pass@host`) |

## Security (`engine: security`)

`SEC-101` eval / dynamic execution · `SEC-102` command injection · `SEC-103` SQL string building ·
`SEC-104` raw HTML injection (XSS) · `SEC-105` path traversal · `SEC-106` unsafe deserialisation ·
`SEC-107` weak password hashing · `SEC-108` non-cryptographic randomness for tokens · `SEC-109` uploads
without limits · `SEC-110` wildcard CORS with credentials · `SEC-111` debug mode in production settings ·
`SEC-112` sensitive values in logs · `SEC-113` TLS verification disabled · `SEC-114` user-controlled
redirect / fetch · `SEC-115` auth token in `localStorage` · `SEC-116` `shell=True` · `SEC-117` CSRF
protection disabled · `SEC-118` unprotected mass assignment · `SEC-119` commented-out code.

## Dependencies (`engine: dependencies`)

`DEP-001` vulnerability confirmed by an advisory (severity taken from the advisory) · `DEP-002` unpinned
version range · `DEP-003` far behind the latest major · `DEP-004` advisories could not be reached, so
nothing was verified (an honest "unknown", never a silent pass).

## Quality (`engine: quality`)

`QUA-001` long function · `QUA-002` high cyclomatic complexity · `QUA-003` duplicated block ·
`QUA-004` swallowed error · `QUA-005` oversized file · `QUA-006` too many parameters · `QUA-007` deep
nesting · `QUA-008` unfinished-work comment · `QUA-009` diagnostic logging in production code ·
`QUA-010` suppressed type checking.

## Architecture (`engine: architecture`)

`ARC-001` circular dependency · `ARC-002` highly coupled module · `ARC-003` UI importing the data layer ·
`ARC-004` oversized module.

## API (`engine: api`)

`API-001` mutating route with no authorisation signal · `API-002` request input without visible
validation · `API-003` internal details in error responses · `API-004` auth routes without throttling ·
`API-005` full object returned including credentials · `API-006` list endpoint without pagination.

## Database (`engine: database`)

`DBN-001` foreign key without an index · `DBN-002` identity-like column without a unique constraint ·
`DBN-003` possible N+1 query · `DBN-004` `SELECT *` in a query · `DBN-005` migration drops a table or
column.

## Docker / CI (`engine: ops`)

`OPS-001` container runs as root · `OPS-002` unpinned base image · `OPS-003` remote script executed
during build · `OPS-004` secrets written into CI files · `OPS-005` privileged container / host network ·
`OPS-006` no `.dockerignore` · `OPS-007` no `.gitignore`.

## Tests (`engine: tests`)

`TST-001` no tests in the project · `TST-002` failing tests in the committed report · `TST-003` coverage
below 50% · `TST-004` tests without a documented run command · `TST-005` skipped or focused tests.

## Severity and confidence

- Severity comes from the rule, except where evidence provides context (a vulnerability advisory's own
  severity and CVSS score override the rule default). Any override stores its reason in
  `severity_reason` and is shown in the UI.
- `confidence` is the detection confidence of the deterministic check (pattern strength, context match).
  `ai_confidence` is stored separately and is never mixed into the detection number.
- Confidence is displayed as a percentage of the documented method — never as a mathematical probability.
