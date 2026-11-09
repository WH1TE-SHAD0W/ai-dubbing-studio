import { apiErrorSchema, hostTokenResponseSchema } from "@ads/contracts";
import { Hono } from "hono";
import { TokenVerifier } from "livekit-server-sdk";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Auth } from "../src/auth/auth.ts";
import { createTokenService } from "../src/livekit/tokens.ts";
import { sessionRoutes } from "../src/routes/sessions.ts";
import { createSessionService } from "../src/sessions/service.ts";
import { TEST_DATABASE_URL, deleteSessions, insertSession, openTestDatabase } from "./db.ts";

// The host's mic token (YGP-71): the signed-in owner of a live session gets a
// token that can only publish, in the session's source room. Against a real
// Postgres; signing is local, so no LiveKit server is needed. The login check
// itself is Better Auth's (tested in app.test.ts): here a stand-in reads the
// host's id from a test header.

const LIVEKIT = { url: "ws://livekit:7880", apiKey: "test-key", apiSecret: "test-secret-".repeat(4) };
const PUBLIC_URL = "wss://live.example.com";
const readToken = (token: string) => new TokenVerifier(LIVEKIT.apiKey, LIVEKIT.apiSecret).verify(token);

const fakeAuth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get("x-test-host");
      return id ? { user: { id }, session: {} } : null;
    },
  },
} as unknown as Auth;

describe.skipIf(!TEST_DATABASE_URL)("the host's mic token", () => {
  let pool: pg.Pool;
  let app: Hono;
  let appWithoutLiveKit: Hono;
  const sessions: string[] = [];

  beforeAll(async () => {
    pool = await openTestDatabase();
    const service = createSessionService(pool, { openSession: async () => [], endSession: async () => 0 });
    const livekit = { publicUrl: PUBLIC_URL, tokens: createTokenService(LIVEKIT) };
    app = new Hono().route("/api/sessions", sessionRoutes(fakeAuth, service, livekit));
    appWithoutLiveKit = new Hono().route("/api/sessions", sessionRoutes(fakeAuth, service));
  });
  afterAll(async () => {
    if (!pool) return;
    await deleteSessions(pool, sessions);
    await pool.end();
  });

  // A session in the database, and its host.
  async function session(status: "draft" | "live" | "ended" = "live") {
    const id = await insertSession(pool, ["de"], status === "ended" ? "live" : status);
    sessions.push(id);
    if (status === "ended") await pool.query("update sessions set status = 'ended', ended_at = now() where id = $1", [id]);
    const { rows } = await pool.query<{ host_id: string }>("select host_id from sessions where id = $1", [id]);
    return { id, hostId: rows[0]!.host_id };
  }

  const askToken = (sessionId: string, hostId: string | null, target = app) =>
    target.request(`/api/sessions/${sessionId}/token`, {
      method: "POST",
      headers: hostId ? { "x-test-host": hostId } : {},
    });

  it("gives the owner of a live session a publish-only token for its source room", async () => {
    const { id, hostId } = await session();
    const res = await askToken(id, hostId);
    expect(res.status).toBe(200);
    const body = hostTokenResponseSchema.parse(await res.json());
    expect(body.serverUrl).toBe(PUBLIC_URL);

    const claims = await readToken(body.token);
    // The host's own identity: a second device takes over from the first.
    expect(claims.sub).toBe(`host-${hostId}`);
    expect(claims.video).toMatchObject({
      room: `ses-${id}-src`,
      roomJoin: true,
      canPublish: true,
      canSubscribe: false,
      canPublishData: false,
    });
  });

  it("answers 401 without a login", async () => {
    const { id } = await session();
    expect((await askToken(id, null)).status).toBe(401);
  });

  it("answers 404 for another host's session or an unknown one, as the other session routes do", async () => {
    const mine = await session();
    const theirs = await session();
    for (const id of [theirs.id, "3f0c2b7e-0000-4000-8000-000000000099"]) {
      const res = await askToken(id, mine.hostId);
      expect(res.status).toBe(404);
      expect(apiErrorSchema.parse(await res.json()).message).toBe("Session not found.");
    }
  });

  it("answers 409 for a draft or ended session", async () => {
    for (const status of ["draft", "ended"] as const) {
      const { id, hostId } = await session(status);
      const res = await askToken(id, hostId);
      expect(res.status).toBe(409);
      expect(apiErrorSchema.parse(await res.json()).message).toBe("This session isn't live.");
    }
  });

  it("answers 501 without LiveKit", async () => {
    const { id, hostId } = await session();
    expect((await askToken(id, hostId, appWithoutLiveKit)).status).toBe(501);
  });
});
