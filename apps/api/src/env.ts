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

export const envSchema = z.object({
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
  TRUSTED_ORIGINS: commaList(z.url({ protocol: /^https?$/ })),
  // Reverse proxies in front of the API (IPs or CIDR ranges). Their
  // X-Forwarded-For is believed; without any, the socket address is the client IP.
  TRUSTED_PROXIES: commaList(z.union([z.cidrv4(), z.cidrv6(), z.ipv4(), z.ipv6()])),

  // The built PWA (ADR-0012). Relative paths are resolved from the working directory.
  WEB_DIST: z.string().min(1).default("../web/dist"),

  // Our numbered .sql migrations (YGP-62). Relative paths are resolved from the
  // working directory, like WEB_DIST.
  MIGRATIONS_DIR: z.string().min(1).default("migrations"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
