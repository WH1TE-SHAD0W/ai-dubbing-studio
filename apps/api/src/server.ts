import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { authOptions, createAuth } from "./auth/auth.ts";
import { createPool } from "./db.ts";
import { loadEnv } from "./env.ts";
import { migrateAuthTables } from "./migrate.ts";
import { runSqlMigrations, withMigrationLock } from "./migrations.ts";

// Starts the API: reads the settings, connects to Postgres, brings Better Auth's
// tables and our own tables up to date, then serves the API and the PWA on one
// port.

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

const webDist = resolve(env.WEB_DIST);
if (!existsSync(join(webDist, "index.html"))) {
  console.warn(`web: no built app in ${webDist}; run \`pnpm --filter @ads/web build\`. Only the API is served.`);
}

const app = createApp({ auth, pool, webDist, trustForwarded: env.TRUSTED_PROXIES.length > 0 });
const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`api: listening on port ${info.port}, public URL ${env.BETTER_AUTH_URL}`);
});

// Docker and Kubernetes stop the container with SIGTERM, then kill it 10 s
// (Docker) or 30 s (Kubernetes) later: finish open requests, close the pool, exit.
let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`api: ${signal} received, shutting down`);
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
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
