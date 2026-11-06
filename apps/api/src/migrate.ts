import type { BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";

// Creates or updates Better Auth's tables (user, account, logins, verification,
// rateLimit). This is what its `migrate` command does, run from code so the API
// container needs no extra tool. Only missing tables and columns are added, so
// running it on every start is safe. Our own tables (sessions, session_languages)
// will come as numbered .sql files (ADR-0002) once sessions are built.
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
