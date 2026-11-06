import { RATE_LIMITED_MESSAGE } from "@ads/contracts";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import type pg from "pg";
import type { Auth } from "./auth/auth.ts";
import { withClientIp } from "./auth/client-ip.ts";
import { isDatabaseUp } from "./db.ts";
import { joinRoutes } from "./routes/join.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { pwa } from "./static.ts";

export type AppDeps = {
  auth: Auth;
  pool: pg.Pool;
  // Folder with the built PWA.
  webDist: string;
  // True when TRUSTED_PROXIES is set: their X-Forwarded-For chain is kept.
  trustForwarded: boolean;
};

// The API routes under /api, typed for Hono's RPC client (ADR-0016).
export function apiRoutes(auth: Auth) {
  return new Hono().route("/sessions", sessionRoutes(auth)).route("/join", joinRoutes());
}
export type ApiRoutes = ReturnType<typeof apiRoutes>;

// Better Auth's 429 body says "Too many requests…"; use the app's wording instead.
async function friendlierRateLimit(res: Response): Promise<Response> {
  if (res.status !== 429) return res;
  const headers = new Headers(res.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ message: RATE_LIMITED_MESSAGE }), { status: 429, headers });
}

export function createApp({ auth, pool, webDist, trustForwarded }: AppDeps) {
  const app = new Hono();

  app.use(secureHeaders());
  // Method, path, status and time only: no bodies, cookies or query strings.
  app.use("/api/*", logger());

  // Liveness (the process answers) and readiness (it can reach Postgres).
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/ready", async (c) =>
    (await isDatabaseUp(pool)) ? c.json({ status: "ok" }) : c.json({ status: "database unavailable" }, 503),
  );

  // Better Auth: sign-up, login, logout, get-session (ADR-0015).
  app.on(["GET", "POST"], "/api/auth/*", async (c) => friendlierRateLimit(await auth.handler(withClientIp(c, trustForwarded))));

  app.route("/api", apiRoutes(auth));
  app.all("/api/*", (c) => c.json({ message: "Not found." }, 404));

  // Everything else is the PWA (ADR-0012).
  app.route("/", pwa(webDist));

  app.onError((err, c) => {
    console.error(`unhandled error on ${c.req.method} ${c.req.path}:`, err);
    return c.json({ message: "Something went wrong. Try again." }, 500);
  });

  return app;
}
