import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { authOptions } from "../src/auth/auth.ts";
import { createPool } from "../src/db.ts";
import { type Env, loadEnv } from "../src/env.ts";
import { migrateAuthTables } from "../src/migrate.ts";
import { runSqlMigrations, withMigrationLock } from "../src/migrations.ts";
import { newJoinCode } from "../src/sessions/repo.ts";

// The database tests use a database of their own. In the development
// database, a running API's sweeper would send their pending translation
// tracks to real translator workers (and real Gemini streams).
//
// TEST_DATABASE_URL if set; otherwise DATABASE_URL with "_test" added to the
// database name (dubbing → dubbing_test), created on first use. Undefined when
// neither is set: the database tests are skipped.
export const TEST_DATABASE_URL = ((): string | undefined => {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  if (!process.env.DATABASE_URL) return undefined;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `${url.pathname}_test`;
  return url.toString();
})();

export const TEST_ORIGIN = "http://localhost:3000";
export const TEST_INTERNAL_TOKEN = "internal-token-".repeat(3);

export function testEnv(): Env {
  return loadEnv({
    DATABASE_URL: TEST_DATABASE_URL,
    BETTER_AUTH_SECRET: "test-secret-".repeat(4),
    BETTER_AUTH_URL: TEST_ORIGIN,
    REDIS_URL: "redis://localhost:6379",
    INTERNAL_API_TOKEN: TEST_INTERNAL_TOKEN,
  });
}

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

// Creates the test database if needed, with Better Auth's tables and ours.
export async function openTestDatabase(): Promise<pg.Pool> {
  await ensureDatabase();
  const env = testEnv();
  const pool = createPool(env.DATABASE_URL);
  // As the API does at start (server.ts): Better Auth's tables, then ours, under one lock.
  await withMigrationLock(pool, async (client) => {
    await migrateAuthTables(authOptions({ env, pool }));
    await runSqlMigrations(client, MIGRATIONS);
  });
  return pool;
}

// A session of a new host with these target languages, straight in the
// database, for tests about its translation tracks. Delete it afterwards with
// deleteSessions (its languages and tracks go with it).
export async function insertSession(pool: pg.Pool, langs: string[], status: "draft" | "live" = "live"): Promise<string> {
  const hostId = randomUUID();
  await pool.query(`insert into "user" (id, name, email, "emailVerified") values ($1, 'Test Host', $2, false)`, [
    hostId,
    `host-${hostId}@example.com`,
  ]);
  const { rows } = await pool.query<{ id: string }>(
    `insert into sessions (host_id, join_code, title, source_lang, status, started_at)
     values ($1, $2, 'Test session', 'en', $3, case when $3 = 'live' then now() end) returning id`,
    [hostId, newJoinCode(), status],
  );
  const id = rows[0]!.id;
  await pool.query(
    `insert into session_languages (session_id, lang, position)
     select $1, lang, position from unnest($2::text[]) with ordinality as t(lang, position)`,
    [id, langs],
  );
  return id;
}

export async function deleteSessions(pool: pg.Pool, ids: string[]): Promise<void> {
  await pool.query("delete from sessions where id = any($1::uuid[])", [ids]);
}

async function ensureDatabase(): Promise<void> {
  if (!TEST_DATABASE_URL || process.env.TEST_DATABASE_URL) return;
  const url = new URL(TEST_DATABASE_URL);
  const name = decodeURIComponent(url.pathname.slice(1));
  url.pathname = "/postgres"; // the maintenance database every server has
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (!rowCount) await client.query(`create database "${name.replaceAll('"', '""')}"`);
  } catch (err) {
    // Another test run created it at the same moment.
    if ((err as { code?: string }).code !== "42P04") throw err;
  } finally {
    await client.end();
  }
}
