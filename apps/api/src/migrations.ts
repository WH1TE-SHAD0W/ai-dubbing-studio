import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";

// Our own tables (sessions, tracks, ...) live as numbered .sql files in
// apps/api/migrations (ADR-0002, YGP-62). Better Auth's tables are made by
// migrateAuthTables in migrate.ts instead.

// Any fixed number works, as long as every copy of the API uses the same one.
const MIGRATION_LOCK_ID = 6201;

// Four digits, an underscore, a lowercase name: e.g. 0001_sessions.sql.
const FILE_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

// Runs `work` while holding a Postgres advisory lock. A second copy of the API
// that starts at the same time waits here until the first has finished, so
// migrations are never applied twice.
export async function withMigrationLock<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  // The lock belongs to one connection, so keep the same one throughout.
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    try {
      return await work(client);
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    }
  } catch (err) {
    broken = true;
    throw err;
  } finally {
    // After an error, throw the connection away rather than reuse it.
    client.release(broken);
  }
}

// Applies every .sql file in `dir` that hasn't run yet, in name order, and
// returns the names of the files it applied. Each file runs in its own
// transaction: if one fails, none of its changes are kept and the error says
// which file it was. Call it inside withMigrationLock.
export async function runSqlMigrations(client: pg.PoolClient, dir: string): Promise<string[]> {
  await client.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const badNames = files.filter((f) => !FILE_NAME.test(f));
  if (badNames.length > 0) {
    throw new Error(
      `migrations: badly named file(s) ${badNames.join(", ")}; use e.g. 0001_sessions.sql`,
    );
  }

  const { rows } = await client.query<{ name: string }>("select name from schema_migrations");
  const done = new Set(rows.map((row) => row.name));

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
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`migrations: ${file} failed, so none of it was applied: ${reason}`, {
        cause: err,
      });
    }
    applied.push(file);
  }
  return applied;
}
