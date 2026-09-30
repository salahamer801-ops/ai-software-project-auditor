import type { Migration } from "./types";

/**
 * 002_hardening_indexes — the read paths every audit page and dashboard actually uses.
 *
 * The audit pages read evidence, AI reviews, test runs and the architecture graph by
 * `audit_run_id`, and the project page reads findings by `project_id` + `status`. None of
 * those had an index, so the cost grew with the size of the history.
 */
export const hardeningIndexes: Migration = {
  id: "002_hardening_indexes",
  description: "Indexes for the audit detail reads, findings-by-status and audit event lookups",
  sql: `
create index if not exists finding_evidence_finding_idx on finding_evidence (finding_id);
create index if not exists findings_project_status_idx on findings (project_id, status);
create index if not exists ai_reviews_run_idx on ai_reviews (audit_run_id);
create index if not exists ai_reviews_finding_idx on ai_reviews (finding_id);
create index if not exists test_runs_run_idx on test_runs (audit_run_id);
create index if not exists architecture_nodes_run_idx on architecture_nodes (audit_run_id);
create index if not exists architecture_edges_run_idx on architecture_edges (audit_run_id);
create index if not exists reports_run_idx on reports (audit_run_id);
create index if not exists audit_events_project_idx on audit_events (project_id, created_at desc);
create index if not exists audit_events_org_idx on audit_events (organization_id, created_at desc);
`,
};
