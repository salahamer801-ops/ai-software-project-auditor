import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { randomUUID } from "node:crypto";
import { logger } from "./observability/log";
import { runMigrations, schemaStatus, type SchemaStatus } from "./db/migrate";

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
    schemaReady = runMigrations(getPool())
      .then((report) => {
        if (report.applied.length > 0) {
          logger.info("db.schema.ready", {
            applied: report.applied,
            durationMs: report.durationMs,
          });
        }
      })
      .catch((err) => {
        // Do not cache a failed boot: the next query retries the migrations.
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}

/** Migration state for the diagnostics panel — read-only, never applies anything. */
export async function schemaDiagnostics(): Promise<SchemaStatus> {
  try {
    return await schemaStatus(getPool());
  } catch {
    return { applied: [], pending: [], drifted: [], latest: "unknown" };
  }
}
