/**
 * Test double for `lib/db.ts`.
 *
 * The real module opens a PostgreSQL pool and runs migrations on first query. The suite is
 * offline by design, so the resolver hook (`tests/loader.mjs`) points `lib/db.ts` here for
 * test processes only: `query` never touches a socket, and the pure modules that imported
 * it (the job state machine, the dependency engine) load normally.
 */

export function getPool(): never {
  throw new Error("the test suite has no database");
}

export async function query<T = Record<string, unknown>>(): Promise<T[]> {
  return [];
}

export async function withTransaction<T>(fn: (client: unknown) => Promise<T>): Promise<T> {
  return fn(undefined);
}

export function newId(prefix: string): string {
  return `${prefix}_test00000000000000000000`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function ensureSchema(): Promise<void> {
  /* nothing to prepare */
}

export async function schemaDiagnostics(): Promise<{
  applied: string[];
  pending: string[];
  drifted: string[];
  latest: string;
}> {
  return { applied: [], pending: [], drifted: [], latest: "unknown" };
}
