import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Redis } from "ioredis";
import { type AppDeps, createApp } from "./app.ts";
import { authOptions, createAuth } from "./auth/auth.ts";
import { createPool } from "./db.ts";
import { loadEnv } from "./env.ts";
import { createMailer } from "./mail/mailer.ts";
import { createRateLimiter } from "./mail/rate-limit.ts";
import { createRoomService } from "./livekit/rooms.ts";
import { createTokenService } from "./livekit/tokens.ts";
import { migrateAuthTables } from "./migrate.ts";
import { runSqlMigrations, withMigrationLock } from "./migrations.ts";
import { createJobQueue } from "./queue/jobs.ts";
import { createTrackService } from "./tracks/service.ts";
import { startSweeper } from "./tracks/sweeper.ts";

// Starts the API: reads the settings, connects to Postgres, brings Better Auth's
// tables and ours up to date, connects to Redis for translation jobs, then
// serves the API, the translator workers' /internal calls and the PWA on one port.

let env;
try {
  env = loadEnv();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const pool = createPool(env.DATABASE_URL);

try {
  // One lock around both, so two API copies starting together can't both
  // create the same tables. Better Auth's go first: ours reference its user table.
  await withMigrationLock(pool, async (client) => {
    const changes = await migrateAuthTables(authOptions({ env, pool }));
    for (const change of changes) console.log(`database: ${change}`);
    const applied = await runSqlMigrations(client, resolve(env.MIGRATIONS_DIR));
    for (const file of applied) console.log(`database: applied migration ${file}`);
  });
} catch (err) {
  console.error(`database: can't prepare the tables: ${err instanceof Error ? err.message : err}`);
  await pool.end();
  process.exit(1);
}

const auth = createAuth({ env, pool });

// Translation tracks (ADR-0018). Redis may be down at start: the API still
// serves, and jobs wait in Postgres until it is back.
let tracks: ReturnType<typeof createTrackService> | undefined;
const queue = createJobQueue({
  url: env.REDIS_URL,
  stream: env.JOB_STREAM,
  group: env.JOB_GROUP,
  // On every (re)connect: send the jobs of pending tracks that have none.
  onReady: async () => void (await tracks?.sendPending()),
});
tracks = createTrackService(pool, queue, {
  leaseTtlSec: env.LEASE_TTL_SEC,
  heartbeatSec: env.HEARTBEAT_SEC,
  maxAttempts: env.TRACK_MAX_ATTEMPTS,
});
const sweeper = startSweeper({ tracks, queue });

// LiveKit (ADR-0020) is optional: env.ts makes sure all three settings are set,
// or none. Without it, sessions have no rooms, claims return no worker tokens
// and listeners and the host get no token (501).
let livekit: AppDeps["internal"]["livekit"];
let rooms: AppDeps["rooms"];
let browser: AppDeps["browser"];
if (env.LIVEKIT_URL) {
  const config = { url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY!, apiSecret: env.LIVEKIT_API_SECRET! };
  const tokens = createTokenService(config);
  livekit = { url: config.url, tokens };
  rooms = createRoomService(config);
  // Browsers need ws:// or wss://; LIVEKIT_URL may be written as http(s)://.
  browser = { publicUrl: env.LIVEKIT_PUBLIC_URL ?? config.url.replace(/^http/, "ws"), tokens };
}

// Listener feedback by email (YGP-119) is optional: env.ts makes sure the mail
// settings are all set, or none. Without them, POST /api/feedback answers 501.
// Its limit (5 an hour per client IP) is counted in Redis, shared by every API copy.
let feedback: AppDeps["feedback"];
let feedbackRedis: Redis | undefined;
if (env.MAIL_USER) {
  const mailer = createMailer({
    host: env.MAIL_HOST,
    port: env.MAIL_PORT,
    user: env.MAIL_USER,
    password: env.MAIL_PASSWORD!,
    to: env.MAIL_TO!,
    from: env.MAIL_FROM,
  });
  // Fail a request quickly when Redis is down, instead of queueing it.
  feedbackRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  feedbackRedis.on("error", (err) => console.error("feedback: redis:", err.message));
  feedback = { mailer, limiter: createRateLimiter(feedbackRedis, { prefix: "feedback", limit: 5, windowSec: 3600 }) };
}

const webDist = resolve(env.WEB_DIST);
if (!existsSync(join(webDist, "index.html"))) {
  console.warn(`web: no built app in ${webDist}; run \`pnpm --filter @ads/web build\`. Only the API is served.`);
}

const app = createApp({
  auth,
  pool,
  webDist,
  trustForwarded: env.TRUSTED_PROXIES.length > 0,
  internal: { token: env.INTERNAL_API_TOKEN, tracks, livekit },
  rooms,
  browser,
  feedback,
  trustedProxies: env.TRUSTED_PROXIES,
});
const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`api: listening on port ${info.port}, public URL ${env.BETTER_AUTH_URL}`);
});

// Docker and Kubernetes stop the container with SIGTERM, then kill it 10 s
// (Docker) or 30 s (Kubernetes) later: stop the sweeper, finish open requests,
// then close Redis and the pool, and exit.
let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`api: ${signal} received, shutting down`);
  void sweeper.stop().finally(() =>
    server.close(() => {
      void queue
        .close()
        .then(() => feedbackRedis?.quit())
        .then(() => pool.end())
        .finally(() => process.exit(0));
    }),
  );
  // Browsers keep sockets open (keep-alive, or opened ahead of a request), and
  // close() waits for them. Drop the idle ones now and the rest after 3 s.
  if ("closeAllConnections" in server) {
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 3_000).unref();
  }
  setTimeout(() => process.exit(1), 8_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
