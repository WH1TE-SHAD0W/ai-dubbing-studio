import { z } from "zod";
import { createPool } from "../db.ts";
import { baseEnvSchema } from "../env.ts";
import { getTracks } from "../tracks/repo.ts";

// Development view of the translation tracks: which worker has each one, its
// lease and attempts. Sessions open and end them (Go live and End session in
// the Studio). Runs on your machine against Postgres from `docker compose`:
//
//   pnpm --filter @ads/api tracks list [<session id>]

const USAGE = `Usage:
  pnpm --filter @ads/api tracks list [<session id>]   show tracks (the latest 100 without an id)`;

const parsed = baseEnvSchema.pick({ DATABASE_URL: true }).safeParse(process.env);
if (!parsed.success) {
  console.error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}
const [command, sessionId] = process.argv.slice(2);
if (command !== "list") {
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}
if (sessionId !== undefined && !z.uuid().safeParse(sessionId).success) {
  console.error(`Give a session id, as the Studio's address shows it (/studio/<id>).\n${USAGE}`);
  process.exit(1);
}

const pool = createPool(parsed.data.DATABASE_URL);
try {
  const rows = await getTracks(pool, sessionId);
  if (rows.length === 0) console.log("no tracks");
  else
    console.table(
      rows.map((t) => ({
        track: t.id,
        session: t.sessionId,
        lang: t.lang,
        status: t.status,
        worker: t.workerId ?? "",
        lease: t.leaseUntil ? `${Math.round((t.leaseUntil.getTime() - Date.now()) / 1000)} s` : "",
        attempts: t.attempts,
        reason: t.reason ?? "",
      })),
    );
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
