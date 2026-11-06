import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMON_PASSWORD_MESSAGE,
  EMAIL_TAKEN_MESSAGE,
  LOGIN_FAILED_MESSAGE,
  RATE_LIMITED_MESSAGE,
  apiErrorSchema,
  joinSessionResponseSchema,
  sessionSchema,
  type Session,
} from "@ads/contracts";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/auth.ts";
import type { JobToSend } from "../src/queue/jobs.ts";
import { createTrackService } from "../src/tracks/service.ts";
import { TEST_DATABASE_URL, TEST_INTERNAL_TOKEN, TEST_ORIGIN, deleteSessions, openTestDatabase, testEnv } from "./db.ts";

// The whole API against a real Postgres (ADR-0002: queries need a real database),
// in a database of its own (see db.ts). Start Postgres with `docker compose up -d
// postgres`, then run with DATABASE_URL or TEST_DATABASE_URL set. Skipped when
// neither is set. Redis is replaced by an in-memory job sender.
const ORIGIN = TEST_ORIGIN;

describe.skipIf(!TEST_DATABASE_URL)("API against Postgres", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let webDist: string;
  // Translation jobs the sessions sent, and the sessions to delete at the end.
  const jobs: JobToSend[] = [];
  const created: string[] = [];

  beforeAll(async () => {
    const env = testEnv();
    pool = await openTestDatabase();
    const auth = createAuth({ env, pool });

    webDist = mkdtempSync(join(tmpdir(), "ads-web-"));
    mkdirSync(join(webDist, "assets"));
    writeFileSync(join(webDist, "index.html"), "<!doctype html><title>AI Dubbing Studio</title>");
    writeFileSync(join(webDist, "assets", "index-abc123.js"), "console.log('app')");
    writeFileSync(join(webDist, "sw.js"), "// service worker");

    // The translator routes have their own tests (internal-routes.test.ts).
    const sender = {
      send: async (job: JobToSend) => {
        jobs.push(job);
        return `${jobs.length}-0`;
      },
    };
    const tracks = createTrackService(pool, sender, { leaseTtlSec: 15, heartbeatSec: 5, maxAttempts: 3 });
    app = createApp({ auth, pool, webDist, trustForwarded: false, internal: { token: env.INTERNAL_API_TOKEN, tracks } });
  });

  afterAll(async () => {
    if (pool) {
      await deleteSessions(pool, created);
      await pool.end();
    }
    if (webDist) rmSync(webDist, { recursive: true, force: true });
  });

  // Each test uses its own client IP, so the rate-limit buckets don't overlap.
  const newIp = () => `10.${rand()}.${rand()}.${rand()}`;
  const rand = () => Math.floor(Math.random() * 254) + 1;
  const newEmail = () => `host-${randomUUID()}@example.com`;
  const PASSWORD = "quiet violet harbour";

  function call(path: string, init: { method?: string; body?: unknown; cookie?: string; ip?: string } = {}) {
    const headers: Record<string, string> = { Origin: ORIGIN, "x-forwarded-for": init.ip ?? newIp() };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.cookie) headers.Cookie = init.cookie;
    return app.request(path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  // "ads.session_token=…; Path=/; HttpOnly; SameSite=Lax" → "ads.session_token=…"
  function loginCookie(res: Response): string {
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("ads.session_token="));
    expect(cookie, "login cookie").toBeDefined();
    return cookie!.split(";")[0]!;
  }

  async function message(res: Response): Promise<string> {
    return apiErrorSchema.parse(await res.json()).message;
  }

  async function register(email = newEmail()) {
    const res = await call("/api/auth/sign-up/email", { body: { name: " Ana Host ", email, password: PASSWORD } });
    expect(res.status).toBe(200);
    return { email, cookie: loginCookie(res) };
  }

  describe("sign-up", () => {
    it("creates the host, logs them in and stores an argon2id hash", async () => {
      const email = newEmail();
      const res = await call("/api/auth/sign-up/email", { body: { name: " Ana Host ", email: email.toUpperCase(), password: PASSWORD } });
      expect(res.status).toBe(200);
      const setCookie = res.headers.getSetCookie().join("\n");
      expect(setCookie).toMatch(/ads\.session_token=[^;]+;.*HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);

      const { rows } = await pool.query(
        `select u.name, u.email, a.password from "user" u join account a on a."userId" = u.id where u.email = $1`,
        [email],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("Ana Host");
      expect(rows[0].password).toMatch(/^argon2id\$65536\$3\$4\$/);

      const session = await call("/api/auth/get-session", { cookie: loginCookie(res) });
      const body = (await session.json()) as { user: { email: string } };
      expect(body.user.email).toBe(email);
    });

    it("says an existing email is already registered", async () => {
      const { email } = await register();
      const res = await call("/api/auth/sign-up/email", { body: { name: "Again", email, password: PASSWORD } });
      expect(res.status).toBe(422);
      expect(await message(res)).toBe(EMAIL_TAKEN_MESSAGE);
    });

    it("applies the contract's password rules and refuses common passwords", async () => {
      const short = await call("/api/auth/sign-up/email", { body: { name: "A", email: newEmail(), password: "too short" } });
      expect(short.status).toBe(400);
      expect(await message(short)).toBe("Use at least 12 characters.");

      const common = await call("/api/auth/sign-up/email", { body: { name: "A", email: newEmail(), password: "Password1234" } });
      expect(common.status).toBe(400);
      expect(await message(common)).toBe(COMMON_PASSWORD_MESSAGE);
    });
  });

  describe("login", () => {
    it("logs in for 12 hours, stored in the logins table", async () => {
      const { email } = await register();
      const res = await call("/api/auth/sign-in/email", { body: { email, password: PASSWORD } });
      expect(res.status).toBe(200);
      const token = decodeURIComponent(loginCookie(res).split("=")[1]!).split(".")[0];

      const { rows } = await pool.query(`select "expiresAt" from logins where token = $1`, [token]);
      expect(rows).toHaveLength(1);
      const hours = (new Date(rows[0].expiresAt).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(11.9);
      expect(hours).toBeLessThanOrEqual(12);
    });

    it("gives the same answer for a wrong password and an unknown email", async () => {
      const { email } = await register();
      const wrong = await call("/api/auth/sign-in/email", { body: { email, password: "not the password" } });
      const unknown = await call("/api/auth/sign-in/email", { body: { email: newEmail(), password: PASSWORD } });
      expect([wrong.status, unknown.status]).toEqual([401, 401]);
      expect(await message(wrong)).toBe(LOGIN_FAILED_MESSAGE);
      expect(await message(unknown)).toBe(LOGIN_FAILED_MESSAGE);
    });

    it("allows 5 login attempts a minute per IP", async () => {
      const ip = newIp();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await call("/api/auth/sign-in/email", { body: { email: newEmail(), password: PASSWORD }, ip });
        statuses.push(res.status);
        if (res.status === 429) expect(await message(res)).toBe(RATE_LIMITED_MESSAGE);
      }
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
      // Another IP is unaffected.
      expect((await call("/api/auth/sign-in/email", { body: { email: newEmail(), password: PASSWORD } })).status).toBe(401);
    });

    it("ends the login on logout", async () => {
      const { cookie } = await register();
      expect((await call("/api/auth/sign-out", { method: "POST", body: {}, cookie })).status).toBe(200);
      const session = await call("/api/auth/get-session", { cookie });
      expect(await session.json()).toBeNull();
    });
  });

  describe("sessions", () => {
    const valid = {
      title: "Keynote",
      sourceLang: "en",
      targetLangs: ["sk", "de"],
      provider: "gemini",
      consent: { speaker: true, aiNotice: true },
    };

    async function create(cookie: string): Promise<Session> {
      const res = await call("/api/sessions", { body: valid, cookie });
      expect(res.status).toBe(201);
      const session = sessionSchema.parse(await res.json());
      created.push(session.id);
      return session;
    }
    async function act(id: string, action: "start" | "end", cookie: string): Promise<Session> {
      const res = await call(`/api/sessions/${id}/${action}`, { method: "POST", cookie });
      expect(res.status).toBe(200);
      return sessionSchema.parse(await res.json());
    }
    const jobsFor = (sessionId: string) => jobs.filter((j) => j.sessionId === sessionId);

    it("need a login", async () => {
      const res = await call("/api/sessions", { body: valid });
      expect(res.status).toBe(401);
      expect(await message(res)).toBe("Log in first.");
    });

    it("check the body against the contract", async () => {
      const { cookie } = await register();
      const bad = await call("/api/sessions", { body: { ...valid, targetLangs: ["en"] }, cookie });
      expect(bad.status).toBe(400);
      expect(await message(bad)).toBe("A target language can't be the spoken language.");
    });

    it("are created as drafts with a join code, and only their host sees them", async () => {
      const { cookie } = await register();
      const session = await create(cookie);
      expect(session).toMatchObject({ title: "Keynote", sourceLang: "en", provider: "gemini", status: "draft" });
      expect(session).toMatchObject({ startedAt: null, endedAt: null });
      // In the order the host picked them; no translation until it goes live.
      expect(session.languages).toEqual([
        { lang: "sk", peakListeners: 0 },
        { lang: "de", peakListeners: 0 },
      ]);
      expect(session.joinCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);

      const again = await call(`/api/sessions/${session.id}`, { cookie });
      expect(sessionSchema.parse(await again.json())).toEqual(session);

      const other = await register();
      const notMine = await call(`/api/sessions/${session.id}`, { cookie: other.cookie });
      expect(notMine.status).toBe(404);
      expect(await message(notMine)).toBe("Session not found.");
      expect((await call(`/api/sessions/${session.id}/start`, { method: "POST", cookie: other.cookie })).status).toBe(404);
      expect((await call("/api/sessions/not-a-session", { cookie })).status).toBe(404);
    });

    it("go live with one translation job per language, and end with their tracks", async () => {
      const { cookie } = await register();
      const session = await create(cookie);

      const live = await act(session.id, "start", cookie);
      expect(live.status).toBe("live");
      expect(live.startedAt).not.toBeNull();
      expect(live.languages.map((l) => [l.lang, l.trackStatus])).toEqual([
        ["sk", "pending"],
        ["de", "pending"],
      ]);
      expect(jobsFor(session.id).map((j) => j.language).sort()).toEqual(["de", "sk"]);

      // Pressing it again (a retry) changes nothing and sends nothing more.
      const twice = await act(session.id, "start", cookie);
      expect(twice.startedAt).toBe(live.startedAt);
      expect(jobsFor(session.id)).toHaveLength(2);

      const ended = await act(session.id, "end", cookie);
      expect(ended.status).toBe("ended");
      expect(ended.endedAt).not.toBeNull();
      expect(ended.languages.map((l) => l.trackStatus)).toEqual(["ended", "ended"]);
      expect((await act(session.id, "end", cookie)).endedAt).toBe(ended.endedAt);
      // An ended session never goes live again.
      expect((await act(session.id, "start", cookie)).status).toBe("ended");
      expect(jobsFor(session.id)).toHaveLength(2);
    });

    it("can be ended before going live, without any translation", async () => {
      const { cookie } = await register();
      const session = await create(cookie);
      const ended = await act(session.id, "end", cookie);
      expect(ended).toMatchObject({ status: "ended", startedAt: null });
      expect(ended.languages.every((l) => l.trackStatus === undefined)).toBe(true);
      expect(jobsFor(session.id)).toHaveLength(0);
    });
  });

  describe("listener routes", () => {
    it("find a session by its code until it ends", async () => {
      const { cookie } = await register();
      const res = await call("/api/sessions", {
        body: { title: "Town hall", sourceLang: "en", targetLangs: ["sk"], provider: "gemini", consent: { speaker: true, aiNotice: true } },
        cookie,
      });
      const session = sessionSchema.parse(await res.json());
      created.push(session.id);

      const found = await call(`/api/join/${session.joinCode.toLowerCase()}`);
      expect(found.status).toBe(200);
      expect(joinSessionResponseSchema.parse(await found.json())).toEqual({
        title: "Town hall",
        hostName: "Ana Host",
        sourceLang: "en",
        languages: ["sk"],
        status: "draft",
      });

      await call(`/api/sessions/${session.id}/end`, { method: "POST", cookie });
      const gone = await call(`/api/join/${session.joinCode}`);
      expect(gone.status).toBe(404);
      expect(await message(gone)).toBe("No session uses this code.");
    });

    it("check the join code and language, LiveKit is a placeholder", async () => {
      expect((await call("/api/join/nope")).status).toBe(400);
      expect((await call("/api/join/ABC123/token", { body: { lang: "xx" } })).status).toBe(400);
      const token = await call("/api/join/abc123/token", { body: { lang: "sk" } });
      expect(token.status).toBe(501);
      expect(await message(token)).toMatch(/LiveKit/);
    });
  });

  describe("serving the PWA", () => {
    it("serves the entry page for app routes, never cached", async () => {
      for (const path of ["/", "/studio", "/listen/ABC123"]) {
        const res = await call(path);
        expect(res.status, path).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/text\/html/);
        expect(res.headers.get("cache-control")).toBe("no-cache");
        expect(await res.text()).toContain("AI Dubbing Studio");
      }
    });

    it("caches hashed assets for a year, but not the service worker", async () => {
      const asset = await call("/assets/index-abc123.js");
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect((await call("/sw.js")).headers.get("cache-control")).toBe("no-cache");
    });

    it("answers 404 for missing files and unknown API paths", async () => {
      expect((await call("/assets/missing.js")).status).toBe(404);
      const api = await call("/api/nothing-here");
      expect(api.status).toBe(404);
      expect(await message(api)).toBe("Not found.");
    });

    it("never answers the translator paths with the app's entry page", async () => {
      // Without the workers' token: 401. With it, an unknown path is a JSON 404.
      expect((await call("/internal/tracks")).status).toBe(401);
      const res = await app.request("/internal/nothing-here", { headers: { Authorization: `Bearer ${TEST_INTERNAL_TOKEN}` } });
      expect(res.status).toBe(404);
      expect(await message(res)).toBe("Not found.");
    });
  });

  it("reports health and readiness", async () => {
    expect((await call("/health")).status).toBe(200);
    expect(await (await call("/ready")).json()).toEqual({ status: "ok" });
  });
});
