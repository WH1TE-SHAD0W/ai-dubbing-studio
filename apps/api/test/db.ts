import pg from "pg";

// Tests that make translation tracks use a database of their own. In the
// development database, a running API's sweeper would send their pending
// tracks to real translator workers (and real Gemini streams).
//
// TEST_DATABASE_URL if set; otherwise DATABASE_URL with "_test" added to the
// database name (dubbing → dubbing_test), created on first use. Undefined when
// neither is set: the tests are skipped.
export const TRACKS_DATABASE_URL = ((): string | undefined => {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  if (!process.env.DATABASE_URL) return undefined;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `${url.pathname}_test`;
  return url.toString();
})();

export async function ensureTracksDatabase(): Promise<void> {
  if (!TRACKS_DATABASE_URL || process.env.TEST_DATABASE_URL) return;
  const url = new URL(TRACKS_DATABASE_URL);
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
