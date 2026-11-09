import { z } from "zod";

// The API's settings, read once at start-up (ADR-0016: environment configuration is
// a boundary too). A missing or malformed value stops the server with a readable
// message instead of failing later on the first request.

// "a, b,c" → ["a", "b", "c"]; empty or unset → [].
const commaList = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item));

// Optional, and an empty value counts as unset: Docker Compose passes an unset
// variable as "".
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

// Every setting, without the checks across settings (the dev CLI picks a few).
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Postgres (ADR-0002). Inside Docker Compose the host is `postgres`.
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: "Set DATABASE_URL to a postgres:// URL." }),

  // Signs and encrypts Better Auth's cookies. `openssl rand -base64 32` makes one.
  BETTER_AUTH_SECRET: z.string().min(32, { error: "Set BETTER_AUTH_SECRET to at least 32 random characters." }),
  // The public origin the browser uses, e.g. http://localhost:3000. An https URL
  // makes the login cookie Secure.
  BETTER_AUTH_URL: z.url({ protocol: /^https?$/ }),
  // Other origins allowed to call /api/auth, e.g. the Vite dev server
  // (http://localhost:5173), whose proxy keeps the browser's Origin header.
  // Kept as bare origins: Better Auth compares the exact string the browser
  // sends, so "http://127.0.0.1:3000/" (trailing slash) would never match.
  TRUSTED_ORIGINS: commaList(z.url({ protocol: /^https?$/ })).transform((urls) => urls.map((url) => new URL(url).origin)),
  // Reverse proxies in front of the API (IPs or CIDR ranges). Their
  // X-Forwarded-For is believed; without any, the socket address is the client IP.
  TRUSTED_PROXIES: commaList(z.union([z.cidrv4(), z.cidrv6(), z.ipv4(), z.ipv6()])),

  // The built PWA (ADR-0012). Relative paths are resolved from the working directory.
  WEB_DIST: z.string().min(1).default("../web/dist"),

  // Our numbered .sql migrations (YGP-62). Relative paths are resolved from the
  // working directory, like WEB_DIST.
  MIGRATIONS_DIR: z.string().min(1).default("migrations"),
  // LiveKit (ADR-0001, ADR-0020): the same key and secret as the LiveKit server.
  // Inside Docker Compose the URL is ws://livekit:7880. Optional until the session
  // routes use LiveKit; set all three or none.
  LIVEKIT_URL: optional(z.url({ protocol: /^(wss?|https?)$/ })),
  LIVEKIT_API_KEY: optional(z.string().min(1)),
  LIVEKIT_API_SECRET: optional(
    z.string().min(32, { error: "Set LIVEKIT_API_SECRET to at least 32 random characters." }),
  ),
  // The LiveKit address listeners' browsers connect to (YGP-71), when it isn't
  // LIVEKIT_URL: inside Compose, browsers can't reach ws://livekit:7880. On a
  // server it's the public wss:// address. Defaults to LIVEKIT_URL.
  LIVEKIT_PUBLIC_URL: optional(z.url({ protocol: /^wss?$/, error: "Set LIVEKIT_PUBLIC_URL to a ws:// or wss:// URL." })),

  // Translation jobs go to the workers through a Redis Stream (ADR-0018).
  // Inside Docker Compose the host is `redis`.
  REDIS_URL: z.url({ protocol: /^rediss?$/, error: "Set REDIS_URL to a redis:// URL." }),
  JOB_STREAM: z.string().min(1).default("translate:jobs"),
  JOB_GROUP: z.string().min(1).default("translators"),
  // Bearer token the translator workers send on /internal. `openssl rand -hex 32` makes one.
  INTERNAL_API_TOKEN: z.string().min(32, { error: "Set INTERNAL_API_TOKEN to at least 32 random characters." }),
  // A worker's claim on a track lasts this long unless a heartbeat renews it.
  LEASE_TTL_SEC: z.coerce.number().int().min(3).max(300).default(15),
  // How often workers renew it.
  HEARTBEAT_SEC: z.coerce.number().int().min(1).max(100).default(5),
  // Workers that may fail or vanish on one track before it is marked failed.
  TRACK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
});

export const envSchema = baseEnvSchema
  .refine(
    (env) => [env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET].every((v) => v === undefined) ||
      [env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET].every((v) => v !== undefined),
    { error: "Set all three of LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET, or none of them." },
  )
  .refine((env) => env.HEARTBEAT_SEC * 3 <= env.LEASE_TTL_SEC, {
    error: "HEARTBEAT_SEC must be at most a third of LEASE_TTL_SEC, so a worker can miss a heartbeat and keep its track.",
    path: ["HEARTBEAT_SEC"],
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
