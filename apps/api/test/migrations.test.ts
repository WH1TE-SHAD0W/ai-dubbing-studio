import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSqlMigrations, withMigrationLock } from "../src/migrations.ts";

// The migration runner against a real Postgres (YGP-62). Set TEST_DATABASE_URL
// or DATABASE_URL to run it; skipped when neither is set. Every test works in a
// throwaway schema of its own, which is dropped at the end, so it never touches
// the real tables.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("migration runner against Postgres", () => {
  let admin: pg.Pool;
  const schemas: string[] = [];
  const pools: pg.Pool[] = [];
  const dirs: string[] = [];

  beforeAll(() => {
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    for (const schema of schemas) await admin.query(`drop schema if exists ${schema} cascade`);
    await admin?.end();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  // A new empty schema, and a pool whose connections only see that schema.
  async function freshDatabase(): Promise<{ schema: string; newPool: () => pg.Pool }> {
    const schema = `migtest_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await admin.query(`create schema ${schema}`);
    schemas.push(schema);
    const newPool = () => {
      const pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}`, max: 3 });
      pools.push(pool);
      return pool;
    };
    return { schema, newPool };
  }

  // A temporary migrations folder holding the given files.
  function migrationsDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "ads-migrations-"));
    dirs.push(dir);
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
    return dir;
  }

  const run = (pool: pg.Pool, dir: string) => withMigrationLock(pool, (client) => runSqlMigrations(client, dir));

  async function recorded(pool: pg.Pool): Promise<string[]> {
    const { rows } = await pool.query<{ name: string }>("select name from schema_migrations order by name");
    return rows.map((row) => row.name);
  }

  async function tableExists(schema: string, table: string): Promise<boolean> {
    const { rows } = await admin.query("select to_regclass($1) as t", [`${schema}.${table}`]);
    return rows[0]?.t !== null;
  }

  it("applies every file on an empty database, in name order", async () => {
    const { newPool } = await freshDatabase();
    const pool = newPool();
    // 0002 only works if 0001 has already run.
    const dir = migrationsDir({
      "0002_add_row.sql": "insert into notes (body) values ('hello');",
      "0001_notes.sql": "create table notes (id serial primary key, body text not null);",
      "README.md": "not a migration",
    });

    expect(await run(pool, dir)).toEqual(["0001_notes.sql", "0002_add_row.sql"]);
    expect(await recorded(pool)).toEqual(["0001_notes.sql", "0002_add_row.sql"]);
    const { rows } = await pool.query("select body from notes");
    expect(rows).toEqual([{ body: "hello" }]);
  });

  it("applies nothing when run again, and only new files after that", async () => {
    const { newPool } = await freshDatabase();
    const pool = newPool();
    const files = { "0001_notes.sql": "create table notes (id serial primary key);" };

    await run(pool, migrationsDir(files));
    expect(await run(pool, migrationsDir(files))).toEqual([]);

    const withNewFile = { ...files, "0002_more.sql": "create table more_notes (id serial primary key);" };
    expect(await run(pool, migrationsDir(withNewFile))).toEqual(["0002_more.sql"]);
    expect(await recorded(pool)).toEqual(["0001_notes.sql", "0002_more.sql"]);
  });

  it("keeps nothing from a failing file, names it, and stops there", async () => {
    const { schema, newPool } = await freshDatabase();
    const pool = newPool();
    const dir = migrationsDir({
      "0001_notes.sql": "create table notes (id serial primary key);",
      // The first statement works, the second fails: neither may be kept.
      "0002_broken.sql": "create table half_done (id int); select * from no_such_table;",
      "0003_later.sql": "create table later (id int);",
    });

    await expect(run(pool, dir)).rejects.toThrow(/0002_broken\.sql failed/);
    expect(await recorded(pool)).toEqual(["0001_notes.sql"]);
    expect(await tableExists(schema, "half_done")).toBe(false);
    expect(await tableExists(schema, "later")).toBe(false);
  });

  it("rejects a badly named file before running anything", async () => {
    const { schema, newPool } = await freshDatabase();
    const pool = newPool();
    const dir = migrationsDir({
      "0001_notes.sql": "create table notes (id int);",
      "sessions.sql": "create table sessions (id int);",
    });

    await expect(run(pool, dir)).rejects.toThrow(/badly named file\(s\) sessions\.sql/);
    expect(await tableExists(schema, "notes")).toBe(false);
  });

  it("applies a file only once when two API copies start together", async () => {
    const { schema, newPool } = await freshDatabase();
    // The sleep keeps the first copy busy while the second one starts. Without
    // the lock, both would try to create the table and one would fail.
    const dir = migrationsDir({ "0001_slow.sql": "select pg_sleep(0.5); create table slow (id int);" });

    const [first, second] = await Promise.all([run(newPool(), dir), run(newPool(), dir)]);
    expect([...first, ...second]).toEqual(["0001_slow.sql"]);
    expect(await tableExists(schema, "slow")).toBe(true);
  });
});
