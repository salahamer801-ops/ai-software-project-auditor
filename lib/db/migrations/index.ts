import { createHash } from "node:crypto";
import type { Migration } from "./types";
import { baseline } from "./001_baseline";
import { hardeningIndexes } from "./002_hardening_indexes";

export type { Migration } from "./types";

/**
 * The migration registry. Append only, in order.
 *
 * Order is what the application runs them in, so a new migration always goes last and
 * never reuses an id. `checksumOf` is what makes an edit to an applied migration visible.
 */
export const MIGRATIONS: Migration[] = [baseline, hardeningIndexes];

export const LATEST_MIGRATION_ID: string = MIGRATIONS[MIGRATIONS.length - 1]?.id ?? "none";

/** Whitespace-insensitive digest of the SQL, so reformatting alone is not "drift". */
export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

export function migrationIds(): string[] {
  return MIGRATIONS.map((migration) => migration.id);
}
