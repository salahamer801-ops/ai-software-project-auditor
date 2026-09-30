/**
 * A migration is immutable once it has been applied anywhere.
 *
 * The runner stores a checksum of every applied migration, so editing an old
 * migration is detected and reported instead of silently diverging the schema.
 * To change the schema, add a new file and register it in `./index.ts`.
 */
export interface Migration {
  /** Ordered identifier: `NNN_slug`, never reused, never renamed. */
  id: string;
  /** One line, printed in the migration log and shown in diagnostics. */
  description: string;
  /** SQL applied inside a single transaction. Keep it idempotent where possible. */
  sql: string;
}
