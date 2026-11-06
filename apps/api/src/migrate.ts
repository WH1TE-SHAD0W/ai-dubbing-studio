import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import type pg from "pg";

// Creates or updates Better Auth's tables (user, account, logins, verification,
// rateLimit). This is what its `migrate` command does, run from code so the API
// container needs no extra tool. Only missing tables and columns are added, so
// running it on every start is safe. Our own tables come from the numbered .sql
// files below (ADR-0002).
//
// Run it before `createAuth`, with the same options (see authOptions).
export async function migrateAuthTables(options: BetterAuthOptions): Promise<string[]> {
  const { toBeCreated, toBeAdded, toBeAddedIndexes, runMigrations } = await getMigrations(options);
  const changes = [
    ...toBeCreated.map((t) => `create table ${t.table}`),
    ...toBeAdded.map((t) => `add columns to ${t.table}: ${Object.keys(t.fields).join(", ")}`),
    ...toBeAddedIndexes.map((i) => `add index ${i.name}`),
  ];
  if (changes.length > 0) await runMigrations();
  return changes;
}

// Our tables (ADR-0002): numbered files in apps/api/migrations, such as
// 0001_translation_tracks.sql, applied in name order. Each file runs once, in
// its own transaction, and is recorded in schema_migrations. Never edit a file
// that has been applied anywhere; add the next number instead.
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
// Any fixed number: two API containers starting at once take turns.
const MIGRATION_LOCK = 4_918_235;

export async function migrateSqlFiles(pool: pg.Pool, dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => MIGRATION_FILE.test(f)).sort();
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const done = new Set((await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), "utf8");
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw new Error(`${file}: ${err instanceof Error ? err.message : err}`);
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
