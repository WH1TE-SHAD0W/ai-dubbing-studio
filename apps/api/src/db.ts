import pg from "pg";

// One connection pool for the whole API (ADR-0002: plain SQL through `pg`).
// Better Auth runs its queries on it too.
export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // An idle connection that drops (e.g. Postgres restarts) must not crash the
  // process; the pool opens a new one on the next query.
  pool.on("error", (err) => console.error(`postgres: idle connection error: ${err.message}`));
  return pool;
}

// Readiness check: true when Postgres answers.
export async function isDatabaseUp(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
}
