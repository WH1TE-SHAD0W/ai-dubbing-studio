import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { languageCodeSchema } from "@ads/contracts";
import { z } from "zod";
import { createPool } from "../db.ts";
import { baseEnvSchema } from "../env.ts";
import { migrateSqlFiles } from "../migrate.ts";
import { createJobQueue } from "../queue/jobs.ts";
import { createTrackService } from "../tracks/service.ts";

// Development stand-in for a session's /start and /end until sessions are
// stored: opens the translation tracks of a made-up session and puts their
// jobs on the stream, or ends them so the workers stop. Runs on your machine
// against Postgres and Redis from `docker compose up -d`:
//
//   pnpm --filter @ads/api tracks open sk de     # prints the session id
//   pnpm --filter @ads/api tracks list [<session id>]
//   pnpm --filter @ads/api tracks end <session id>

const USAGE = `Usage:
  pnpm --filter @ads/api tracks open <lang> [<lang>…]   open a test session's tracks and send their jobs
  pnpm --filter @ads/api tracks list [<session id>]     show tracks (the latest 100 without an id)
  pnpm --filter @ads/api tracks end <session id>        end them; their workers stop`;

const settings = baseEnvSchema.pick({
  DATABASE_URL: true,
  REDIS_URL: true,
  JOB_STREAM: true,
  JOB_GROUP: true,
  MIGRATIONS_DIR: true,
  LEASE_TTL_SEC: true,
  HEARTBEAT_SEC: true,
  TRACK_MAX_ATTEMPTS: true,
});

const parsed = settings.safeParse(process.env);
if (!parsed.success) {
  console.error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}
const env = parsed.data;
const [command, ...args] = process.argv.slice(2);

const pool = createPool(env.DATABASE_URL);
const queue = createJobQueue({ url: env.REDIS_URL, stream: env.JOB_STREAM, group: env.JOB_GROUP });
const tracks = createTrackService(pool, queue, {
  leaseTtlSec: env.LEASE_TTL_SEC,
  heartbeatSec: env.HEARTBEAT_SEC,
  maxAttempts: env.TRACK_MAX_ATTEMPTS,
});

let code = 0;
try {
  await migrateSqlFiles(pool, resolve(env.MIGRATIONS_DIR));
  switch (command) {
    case "open": {
      const langs = z.array(languageCodeSchema).min(1).safeParse(args);
      if (!langs.success) throw new Error(`Give one or more target languages, e.g. sk de.\n${USAGE}`);
      await waitForRedis();
      const sessionId = randomUUID();
      printTracks(await tracks.openSession(sessionId, langs.data));
      console.log(`\nsession ${sessionId}\nend it with: pnpm --filter @ads/api tracks end ${sessionId}`);
      break;
    }
    case "list":
      printTracks(await tracks.list(args[0]));
      break;
    case "end": {
      const sessionId = z.uuid().safeParse(args[0]);
      if (!sessionId.success) throw new Error(`Give the session id that \`open\` printed.\n${USAGE}`);
      console.log(`ended ${await tracks.endSession(sessionId.data)} track(s)`);
      break;
    }
    default:
      console.log(USAGE);
      code = command ? 1 : 0;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  code = 1;
} finally {
  await queue.close();
  await pool.end();
}
process.exit(code);

// The queue connects in the background; give it a few seconds before sending.
async function waitForRedis() {
  for (let i = 0; i < 50 && !queue.isUp(); i++) await new Promise((r) => setTimeout(r, 100));
  if (!queue.isUp()) throw new Error(`Can't reach Redis at ${env.REDIS_URL}. Is \`docker compose up -d redis\` running?`);
}

function printTracks(rows: Awaited<ReturnType<typeof tracks.list>>) {
  if (rows.length === 0) return console.log("no tracks");
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
}
