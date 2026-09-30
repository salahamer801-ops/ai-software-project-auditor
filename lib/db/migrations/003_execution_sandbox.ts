import type { Migration } from "./types";

/**
 * V1.2 — the execution sandbox.
 *
 * Three additions, all additive so the migration is safe on a live database:
 *
 *  - `audit_jobs.options`: the choices made when the audit was queued. Executing project code is
 *    opt-in and the record of that choice belongs to the job, not to the request that started it.
 *  - `test_runs.mode` / `cases` / `sandbox` / `truncated`: an executed run is a different kind of
 *    evidence from a parsed artifact file, and the report must be able to say which one it is
 *    holding, what ran, and under exactly which limits.
 *  - the index is for the audit page, which reads the executed run of a given audit directly.
 */
export const executionSandbox: Migration = {
  id: "003_execution_sandbox",
  description: "job options plus executed test runs with their sandbox metadata",
  sql: `
alter table audit_jobs add column if not exists options jsonb not null default '{}'::jsonb;

alter table test_runs add column if not exists mode text;
alter table test_runs add column if not exists cases jsonb not null default '[]'::jsonb;
alter table test_runs add column if not exists sandbox jsonb;
alter table test_runs add column if not exists truncated boolean not null default false;

create index if not exists test_runs_executed_idx on test_runs (audit_run_id, executed);
`,
};
