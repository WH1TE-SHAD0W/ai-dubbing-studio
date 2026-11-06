import {
  COMMON_PASSWORD_MESSAGE,
  EMAIL_TAKEN_MESSAGE,
  LOGIN_FAILED_MESSAGE,
  PASSWORD_MAX,
  PASSWORD_MIN,
  registerRequestSchema,
} from "@ads/contracts";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import type { Pool } from "pg";
import type { Env } from "../env.ts";
import { isCommonPassword } from "./common-passwords.ts";
import { hashPassword, verifyPassword } from "./password.ts";

// Better Auth for host accounts (ADR-0015), configured as ADR-0003 decides.
// Mounted at /api/auth; the PWA's Better Auth client calls it on the same origin.

const TWELVE_HOURS = 12 * 60 * 60;

// Runs before Better Auth's own handling: checks new accounts against the shared
// contract, so the server and the Register form give the same answers.
const before = createAuthMiddleware(async (ctx) => {
  if (ctx.path === "/sign-up/email") {
    const parsed = registerRequestSchema.safeParse(ctx.body);
    if (!parsed.success) {
      throw new APIError("BAD_REQUEST", { message: parsed.error.issues[0]?.message ?? "Invalid request." });
    }
    if (isCommonPassword(parsed.data.password)) {
      throw new APIError("BAD_REQUEST", { message: COMMON_PASSWORD_MESSAGE, code: "PASSWORD_TOO_COMMON" });
    }
    // Store the trimmed name and normalised email.
    return { context: { body: { ...ctx.body, ...parsed.data } } };
  }
  if (ctx.path === "/change-password") {
    const newPassword: unknown = ctx.body?.newPassword;
    if (typeof newPassword === "string" && isCommonPassword(newPassword)) {
      throw new APIError("BAD_REQUEST", { message: COMMON_PASSWORD_MESSAGE, code: "PASSWORD_TOO_COMMON" });
    }
    // A password change ends the host's other logins (ADR-0003).
    return { context: { body: { ...ctx.body, revokeOtherSessions: true } } };
  }
  return undefined;
});

// Runs after Better Auth: replaces its error wording with ours.
const after = createAuthMiddleware(async (ctx) => {
  const returned = ctx.context.returned;
  if (!isAPIError(returned)) return;
  if (ctx.path === "/sign-in/email" && (returned.status === "UNAUTHORIZED" || returned.status === "BAD_REQUEST")) {
    // The same answer whether the email exists or not (ADR-0003). Better Auth
    // already hashes the password for unknown emails, so the timing matches too.
    throw new APIError(returned.status, { message: LOGIN_FAILED_MESSAGE, code: "INVALID_EMAIL_OR_PASSWORD" });
  }
  if (ctx.path === "/sign-up/email" && returned.body?.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
    throw new APIError(returned.status, { message: EMAIL_TAKEN_MESSAGE, code: returned.body.code });
  }
});

export type AuthDeps = { env: Env; pool: Pool };

// The options on their own, so the tables can be migrated before Better Auth
// starts: it checks the schema as soon as it is created.
export function authOptions({ env, pool }: AuthDeps) {
  return {
    appName: "AI Dubbing Studio",
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: env.TRUSTED_ORIGINS,
    database: pool,
    telemetry: { enabled: false },

    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      // Registering logs the host straight in, as the Register page expects.
      autoSignIn: true,
      // No email sending yet, so no verification or reset (ADR-0003).
      requireEmailVerification: false,
      revokeSessionsOnPasswordReset: true,
      password: { hash: hashPassword, verify: verifyPassword },
    },

    // Each login is a row in `logins` (Better Auth's session table, renamed so
    // "session" keeps meaning a live event). 12 hours, fixed: activity doesn't
    // extend it, and it outlasts the longest live session (4 hours).
    session: {
      modelName: "logins",
      expiresIn: TWELVE_HOURS,
      disableSessionRefresh: true,
    },

    // On everywhere (Better Auth's default is production only), and stored in
    // Postgres so every API instance shares the counts.
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60 * 60, max: 10 },
      },
    },

    advanced: {
      cookiePrefix: "ads",
      // HttpOnly and SameSite=Lax are Better Auth's defaults; Secure follows the URL.
      useSecureCookies: env.BETTER_AUTH_URL.startsWith("https:"),
      ipAddress: {
        // The API sets X-Forwarded-For itself before Better Auth reads it
        // (see client-ip.ts), so a client can't pick its own rate-limit bucket.
        ipAddressHeaders: ["x-forwarded-for"],
        trustedProxies: env.TRUSTED_PROXIES,
      },
    },

    hooks: { before, after },
  } satisfies BetterAuthOptions;
}

export function createAuth(deps: AuthDeps) {
  return betterAuth(authOptions(deps));
}

export type Auth = ReturnType<typeof createAuth>;
export type Host = Auth["$Infer"]["Session"]["user"];
export type Login = Auth["$Infer"]["Session"]["session"];
