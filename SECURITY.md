# Security model

The audited repository is treated as **untrusted input**. Everything below is enforced in code, not by
convention.

## 1. Untrusted input handling

| Risk | Control |
| --- | --- |
| Malicious code in the repository | Nothing from the repository is executed: no install, no build, no test run, no shell. Files are read as text. |
| Archive bombs / oversized uploads | Hard caps: 6 000 entries, 4 MB per entry, 40 MB extracted, 30 MB upload; entries above a cap are recorded as skipped, not read. |
| Path traversal (`../../etc/passwd`) | Every entry path is normalised, absolute paths and any `..` segment are rejected, and the archive root prefix is stripped explicitly. |
| Vendor noise and binaries | `node_modules`, `.git`, `vendor`, build output and binary extensions are ignored or flagged as binary by NUL-byte sniffing. |
| SSRF from the audited project | No request is ever made to a host named by the repository. Outbound calls are limited to `api.github.com`, `api.osv.dev`, the npm/PyPI registries and the configured AI endpoint. |
| Secret exposure | Detected values are masked in engine output, evidence rows, findings, reports and the UI (`scrubSecrets()` runs twice). The full value is never stored. |

## 2. Authentication and sessions

- Passwords: scrypt (`N=16384, r=8, p=1`) with a 16-byte random salt per user, compared in constant time.
- Sessions: 32-byte random token, only its SHA-256 hash is stored, `httpOnly` + `SameSite=Lax` cookie,
  `Secure` in production, 30-day expiry, revoked on logout.
- Rate limiting: failed login/registration attempts are counted per e-mail and per IP over a 15-minute
  window (8 failures) and the request is refused with 429.
- Authorisation lives on the server: `getProjectAccess()` joins project → organisation → membership on
  every request, and routes require a minimum role (`viewer < developer < admin < owner`). The UI never
  decides access on its own.

## 3. Request integrity

- Mutating requests are checked with `isSameOrigin()`: `Sec-Fetch-Site` (which scripts cannot forge),
  forwarded/host comparison, referer and the published origin. Cross-site requests are rejected with 403.
- Response hardening headers (`nosniff`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`) are
  set in `next.config.ts`.
- All user input is validated at the API boundary (type, length, e-mail format, enum membership) and
  bounded before it reaches SQL. Every query uses bound parameters.

## 4. Audit and data integrity

- `audit_events` records account, project and audit actions; `finding_events` records every status change
  with its reason and author.
- Finding history is append-only: marking a finding a false positive writes a decision, it never deletes a
  row or hides the original finding from a previous audit.
- Severity overrides keep their source and reason (`severity_source`, `severity_reason`).

## 5. AI usage

- Optional. With no `AI_API_KEY` nothing leaves the platform and explanations are produced by the rules
  engine, labelled `rules_engine` in the UI and in the report.
- Only minimal context is sent: the rule, the masked snippet, a small code window and general project
  facts — never the whole repository, never a raw secret.
- Output must be JSON matching the prompt contract; any file/line reference that does not exist in the
  analysed manifest is rejected and recorded in `rejected_evidence_refs`.

## 6. Executing project code

Repository content is untrusted input, and execution is the only feature that acts on it. Two rules follow.

**Opt-in, per audit.** The job row carries the choice (`audit_jobs.options`). Nothing executes unless the
person queued the audit with execution enabled, and the audit's report states whether it ran.

**Bounded by construction.** The child process gets Node's permission model with only the workspace
readable, a guard loaded before project code that makes outbound network entry points throw, an
environment rebuilt from scratch (no database URL, no tokens, no host paths), a heap cap, a per-file
deadline enforced with SIGKILL, and a workspace deleted in a `finally`.

**What is out of scope, stated rather than implied.** This is not container isolation. Guards live in the
same process as the code they police, so a native addon or a low-level bypass is outside what they can
promise; the audit report says exactly that. There is no dependency install, so nothing can pull code from
a registry into the run. There is no disk write anywhere in the child, so execution cannot leave anything
behind except its own stdout, which is masked and truncated before storage.

**One run at a time.** Executions are serialised inside the server process, so a single host cannot be
saturated by concurrent audits, and a second audit that requested execution reports that it was deferred
instead of silently skipping it.

## 7. Reporting a problem

If you find an issue in this platform (not in an audited project), describe it in the chat with the steps
to reproduce it. A finding about your own project can be marked as a false positive from the finding page;
that decision is stored with its reason and re-applied in future audits.
