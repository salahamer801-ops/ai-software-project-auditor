/**
 * Migration registry — `lib/db/migrations/index.ts` (pure: no database connection).
 *
 * The registry is append-only, and the checksum is what makes an edit to an applied
 * migration visible instead of silently diverging the schema.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checksumOf, LATEST_MIGRATION_ID, migrationIds, MIGRATIONS } from "../lib/db/migrations";

describe("migration registry", () => {
  test("is not empty and every migration is complete", () => {
    assert.ok(MIGRATIONS.length > 0, "there must be at least one migration");
    for (const migration of MIGRATIONS) {
      assert.equal(typeof migration.id, "string", "a migration needs an id");
      assert.ok(migration.id.trim().length > 0);
      assert.equal(typeof migration.description, "string", `${migration.id}: description must be a string`);
      assert.ok(migration.description.trim().length > 0, `${migration.id}: description must not be empty`);
      assert.match(migration.id, /^\d{3}_[a-z0-9_]+$/, `unexpected migration id format: ${migration.id}`);
      assert.equal(typeof migration.sql, "string", `${migration.id}: sql must be a string`);
      assert.ok(migration.sql.trim().length > 0, `${migration.id}: sql must not be empty`);
    }
  });

  test("ids are unique and in ascending order", () => {
    const ids = migrationIds();
    assert.equal(ids.length, MIGRATIONS.length);
    assert.equal(new Set(ids).size, ids.length, "a migration id must never be reused");
    assert.deepEqual(ids, [...ids].sort(), "migrations must be registered in ascending order");
    for (let index = 1; index < ids.length; index += 1) {
      assert.ok(ids[index - 1] < ids[index], `${ids[index - 1]} must sort before ${ids[index]}`);
    }
  });

  test("LATEST_MIGRATION_ID is the last registered migration", () => {
    assert.equal(LATEST_MIGRATION_ID, MIGRATIONS[MIGRATIONS.length - 1].id);
    assert.equal(LATEST_MIGRATION_ID, migrationIds()[migrationIds().length - 1]);
  });

  test("the SQL is written defensively (idempotent where it can be)", () => {
    const baseline = MIGRATIONS[0];
    assert.match(baseline.sql, /create table if not exists/i, "the baseline creates tables defensively");
    assert.ok(
      MIGRATIONS.every((migration) => !/\bdrop\s+table\b/i.test(migration.sql)),
      "no migration drops a table",
    );
    assert.ok(
      MIGRATIONS.every((migration) => !/\bdelete\s+from\b/i.test(migration.sql)),
      "no migration deletes rows",
    );
  });
});

describe("checksumOf", () => {
  test("is stable across reformatting", () => {
    const sql = "create table if not exists t (\n  id text primary key\n);\n";
    const reflowed = "create table if not exists t (   id text primary key );\n\n";
    assert.equal(checksumOf(sql), checksumOf(reflowed), "whitespace alone is not drift");
    assert.equal(checksumOf(sql), checksumOf(sql.replace(/\s+/g, " ").trim() + " "));
  });

  test("changes when the SQL changes, however slightly", () => {
    const base = "create index if not exists i on t (a)";
    assert.notEqual(checksumOf(base), checksumOf("create index if not exists i on t (b)"));
    assert.notEqual(checksumOf(base), checksumOf(`${base} where a is not null`), "a trailing clause changes it too");
    assert.equal(checksumOf(""), checksumOf("   "), "whitespace-only SQL normalises to the same empty digest");
  });

  test("is a short, deterministic digest", () => {
    const digest = checksumOf("select 1");
    assert.match(digest, /^[0-9a-f]{16}$/, "the checksum is 16 hex characters");
    assert.equal(digest, checksumOf("select 1"), "the same input always produces the same checksum");
    assert.equal(new Set(MIGRATIONS.map((migration) => checksumOf(migration.sql))).size, MIGRATIONS.length, "no two migrations share a checksum");
  });
});
