import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { randomUUID } from "node:crypto";

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

function needsSsl(url: string): boolean {
  if (/sslmode=disable/.test(url)) return false;
  if (/sslmode=require|sslmode=verify/.test(url)) return true;
  return !/@(localhost|127\.0\.0\.1)/.test(url);
}

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not configured for this project yet — the database is provisioned with the app configuration.",
    );
  }
  pool = new Pool({
    connectionString,
    max: 5,
    // Published apps sleep when idle: keep few, short-lived connections so we never
    // hand a stale socket to the next request.
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 15_000,
    allowExitOnIdle: true,
    ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  pool.on("error", () => {
    /* swallow: the next query reconnects */
  });
  return pool;
}

const RETRYABLE = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "57P01",
  "57P02",
  "57P03",
  "08006",
  "08003",
  "08001",
]);

function errorCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "";
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  await ensureSchema();
  const run = async () => {
    const p = getPool();
    const res = await p.query<T>(text, params as never[]);
    return res.rows;
  };
  try {
    return await run();
  } catch (err) {
    if (!RETRYABLE.has(errorCode(err))) throw err;
    // A sleeping database can hand back a dead socket — one fresh retry.
    pool = null;
    await new Promise((r) => setTimeout(r, 300));
    return run();
  }
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const p = getPool();
      await p.query(SCHEMA_SQL);
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

export const SCHEMA_SQL = `
create table if not exists users (
  id text primary key,
  name text not null,
  email text not null,
  password_hash text not null,
  locale text not null default 'ar',
  avatar_url text,
  is_demo boolean not null default false,
  email_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists users_email_key on users (lower(email));

create table if not exists sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  token_hash text not null unique,
  user_agent text,
  ip text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists sessions_user_idx on sessions (user_id);

create table if not exists organizations (
  id text primary key,
  name text not null,
  slug text not null unique,
  owner_id text not null references users(id) on delete cascade,
  plan text not null default 'free',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists organization_members (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table if not exists login_attempts (
  id text primary key,
  email text,
  ip text,
  kind text not null default 'login',
  success boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists login_attempts_email_idx on login_attempts (lower(email), created_at desc);

create table if not exists projects (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  created_by text references users(id) on delete set null,
  name text not null,
  slug text not null,
  source_type text not null,
  provider text,
  repository_url text,
  repo_owner text,
  repo_name text,
  default_branch text,
  visibility text,
  language text,
  framework text,
  retention_days integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists projects_org_slug_key on projects (organization_id, slug) where deleted_at is null;

create table if not exists repositories (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  provider text,
  external_id text,
  owner text,
  repository_name text,
  branch text,
  installation_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create table if not exists audit_jobs (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  repository_id text references repositories(id) on delete set null,
  triggered_by text references users(id) on delete set null,
  commit_sha text,
  branch text,
  ref text,
  status text not null default 'QUEUED',
  progress integer not null default 0,
  stages jsonb not null default '[]'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now()
);
create index if not exists audit_jobs_project_idx on audit_jobs (project_id, created_at desc);

create table if not exists audit_runs (
  id text primary key,
  audit_job_id text not null references audit_jobs(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  engine_version text not null,
  rule_version text not null,
  ai_model text,
  status text not null,
  stack jsonb,
  stats jsonb,
  summary jsonb,
  limitations jsonb,
  engines jsonb,
  source jsonb,
  commit_sha text,
  branch text,
  duration_ms integer,
  created_at timestamptz not null default now()
);
create index if not exists audit_runs_project_idx on audit_runs (project_id, created_at desc);

create table if not exists findings (
  id text primary key,
  audit_run_id text not null references audit_runs(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  rule_id text not null,
  rule_version text not null,
  engine text not null,
  category text not null,
  severity text not null,
  severity_source text not null default 'rule',
  severity_reason text,
  confidence double precision not null default 0.8,
  detection_confidence double precision,
  ai_confidence double precision,
  title jsonb not null,
  description jsonb,
  impact jsonb,
  recommendation jsonb,
  status text not null default 'open',
  status_reason text,
  status_updated_at timestamptz,
  status_updated_by text,
  file_path text,
  line_start integer,
  line_end integer,
  symbol text,
  evidence jsonb,
  detection_method jsonb,
  tool_reference text,
  fingerprint text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index if not exists findings_run_idx on findings (audit_run_id, severity);
create index if not exists findings_project_fp_idx on findings (project_id, fingerprint);

create table if not exists finding_evidence (
  id text primary key,
  finding_id text not null references findings(id) on delete cascade,
  source_type text not null,
  source_reference text not null,
  snippet text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create table if not exists finding_events (
  id text primary key,
  finding_id text not null references findings(id) on delete cascade,
  user_id text references users(id) on delete set null,
  action text not null,
  reason text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists finding_decisions (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  fingerprint text not null,
  user_id text references users(id) on delete set null,
  decision text not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (project_id, fingerprint)
);

create table if not exists dependencies (
  id text primary key,
  audit_run_id text not null references audit_runs(id) on delete cascade,
  package_manager text not null,
  package_name text not null,
  version text not null,
  ecosystem text not null,
  scope text not null default 'direct',
  manifest_path text,
  vulnerability_count integer not null default 0,
  license text,
  latest_version text,
  outdated boolean,
  created_at timestamptz not null default now()
);
create index if not exists dependencies_run_idx on dependencies (audit_run_id);

create table if not exists vulnerabilities (
  id text primary key,
  dependency_id text not null references dependencies(id) on delete cascade,
  advisory_id text not null,
  severity text not null,
  cvss double precision,
  summary text,
  description text,
  fixed_version text,
  source text not null,
  published_at text,
  advisory_references jsonb,
  created_at timestamptz not null default now()
);

create table if not exists test_runs (
  id text primary key,
  audit_run_id text not null references audit_runs(id) on delete cascade,
  framework text,
  command text,
  status text not null,
  executed boolean not null default false,
  passed integer,
  failed integer,
  skipped integer,
  coverage double precision,
  duration_ms integer,
  output_excerpt text,
  source_reference text,
  created_at timestamptz not null default now()
);

create table if not exists architecture_nodes (
  id text primary key,
  audit_run_id text not null references audit_runs(id) on delete cascade,
  path text not null,
  type text,
  language text,
  metadata jsonb
);

create table if not exists architecture_edges (
  id text primary key,
  audit_run_id text not null references audit_runs(id) on delete cascade,
  source_path text not null,
  target_path text not null,
  relationship text not null default 'imports'
);

create table if not exists ai_reviews (
  id text primary key,
  audit_run_id text not null references audit_runs(id) on delete cascade,
  finding_id text references findings(id) on delete cascade,
  model text,
  prompt_version text not null,
  kind text not null,
  result jsonb,
  confidence double precision,
  token_usage jsonb,
  evidence_refs jsonb,
  limitations jsonb,
  rejected_evidence_refs jsonb,
  created_at timestamptz not null default now()
);

create table if not exists reports (
  id text primary key,
  audit_run_id text not null references audit_runs(id) on delete cascade,
  format text not null,
  storage_path text,
  generated_at timestamptz not null default now(),
  payload jsonb
);

create table if not exists audit_policies (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  name text not null,
  configuration jsonb,
  created_at timestamptz not null default now()
);

create table if not exists audit_events (
  id text primary key,
  organization_id text,
  user_id text,
  project_id text,
  action text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create table if not exists rules_catalog (
  id text primary key,
  version text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists registry_cache (
  key text primary key,
  payload jsonb,
  fetched_at timestamptz not null default now()
);

create table if not exists project_sources (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  kind text not null,
  filename text,
  bytes bytea,
  size integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists project_sources_project_idx on project_sources (project_id);
`;
