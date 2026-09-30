import type { Pool, QueryResultRow } from "pg";
import { logger } from "../observability/log";
import { MIGRATIONS, checksumOf } from "./migrations";

/**
 * Session-level advisory lock, so two instances booting at the same time cannot apply the
 * same migration twice. It is unlocked explicitly: a pooled connection stays alive after
 * `release()`, so it would otherwise keep the lock.
 */
const MIGRATIONS_LOCK_KEY = 918_273_645;

const MIGRATIONS_TABLE = `
create table if not exists schema_migrations (
  id text primary key,
  checksum text not null,
  description text,
  duration_ms integer not null default 0,
  applied_at timestamptz not null default now()
);
`;

export interface MigrationReport {
  applied: string[];
  skipped: string[];
  /** Applied migrations whose stored checksum no longer matches the file. */
  drifted: string[];
  durationMs: number;
}

interface AppliedRow extends QueryResultRow {
  id: string;
  checksum: string;
}

/**
 * Applies every pending migration, in order, each inside its own transaction.
 *
 * Written for a host that boots on the first request: it is safe to call on every cold
 * start (the common case is "nothing pending" and one cheap table check), it is safe to
 * call concurrently from several instances (advisory lock), and a failure rolls that one
 * migration back and leaves the database on the previous version.
 */
export async function runMigrations(pool: Pool): Promise<MigrationReport> {
  const startedAll = Date.now();
  const report: MigrationReport = { applied: [], skipped: [], drifted: [], durationMs: 0 };
  const client = await pool.connect();
  try {
    await client.query(MIGRATIONS_TABLE);
    await client.query("select pg_advisory_lock($1)", [MIGRATIONS_LOCK_KEY]);
    try {
      const { rows } = await client.query<AppliedRow>("select id, checksum from schema_migrations");
      const applied = new Map(rows.map((row) => [row.id, row.checksum]));

      for (const migration of MIGRATIONS) {
        const checksum = checksumOf(migration.sql);
        const previous = applied.get(migration.id);

        if (previous !== undefined) {
          if (previous !== checksum) {
            // Deliberately not fatal: an unavailable application is worse than a schema that
            // was changed after the fact. The drift is reported in the log and in diagnostics.
            report.drifted.push(migration.id);
            logger.error("db.migration.drift", {
              id: migration.id,
              expected: checksum,
              stored: previous,
            });
          } else {
            report.skipped.push(migration.id);
          }
          continue;
        }

        const started = Date.now();
        await client.query("begin");
        try {
          await client.query(migration.sql);
          const durationMs = Date.now() - started;
          await client.query(
            "insert into schema_migrations (id, checksum, description, duration_ms) values ($1, $2, $3, $4)",
            [migration.id, checksum, migration.description, durationMs],
          );
          await client.query("commit");
          report.applied.push(migration.id);
          logger.info("db.migration.applied", {
            id: migration.id,
            description: migration.description,
            durationMs,
          });
        } catch (err) {
          await client.query("rollback").catch(() => undefined);
          logger.error("db.migration.failed", { id: migration.id, error: err });
          throw err;
        }
      }
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATIONS_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
  report.durationMs = Date.now() - startedAll;
  if (report.applied.length > 0) {
    logger.info("db.migration.complete", {
      applied: report.applied,
      durationMs: report.durationMs,
    });
  }
  return report;
}

export interface SchemaStatus {
  applied: string[];
  pending: string[];
  drifted: string[];
  latest: string;
}

/** Reads the migration state without changing it — used by the diagnostics panel. */
export async function schemaStatus(pool: Pool): Promise<SchemaStatus> {
  const { rows } = await pool.query<AppliedRow>("select id, checksum from schema_migrations");
  const appliedChecksums = new Map(rows.map((row) => [row.id, row.checksum]));
  const pending: string[] = [];
  const drifted: string[] = [];

  for (const migration of MIGRATIONS) {
    const stored = appliedChecksums.get(migration.id);
    if (stored === undefined) pending.push(migration.id);
    else if (stored !== checksumOf(migration.sql)) drifted.push(migration.id);
  }

  return {
    applied: rows.map((row) => row.id).sort(),
    pending,
    drifted,
    latest: MIGRATIONS[MIGRATIONS.length - 1]?.id ?? "none",
  };
}
