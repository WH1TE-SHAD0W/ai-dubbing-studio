import { apiErrorSchema, listenerTokenResponseSchema } from "@ads/contracts";
import { Hono } from "hono";
import { TokenVerifier } from "livekit-server-sdk";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTokenService } from "../src/livekit/tokens.ts";
import { joinRoutes } from "../src/routes/join.ts";
import { createSessionService } from "../src/sessions/service.ts";
import { TEST_DATABASE_URL, deleteSessions, insertSession, openTestDatabase } from "./db.ts";

// The listener token (YGP-71): a join code and a language get a token that can
// only listen, in that language's output room, while the session is live.
// Against a real Postgres; signing is local, so no LiveKit server is needed.

const LIVEKIT = { url: "ws://livekit:7880", apiKey: "test-key", apiSecret: "test-secret-".repeat(4) };
const PUBLIC_URL = "wss://live.example.com";
const readToken = (token: string) => new TokenVerifier(LIVEKIT.apiKey, LIVEKIT.apiSecret).verify(token);

describe.skipIf(!TEST_DATABASE_URL)("the listener token", () => {
  let pool: pg.Pool;
  let app: Hono;
  let appWithoutLiveKit: Hono;
  const sessions: string[] = [];

  beforeAll(async () => {
    pool = await openTestDatabase();
    // The token route only reads sessions; it never opens or ends tracks.
    const service = createSessionService(pool, { openSession: async () => [], endSession: async () => 0 });
    const livekit = { publicUrl: PUBLIC_URL, tokens: createTokenService(LIVEKIT) };
    app = new Hono().route("/api/join", joinRoutes(service, livekit));
    appWithoutLiveKit = new Hono().route("/api/join", joinRoutes(service));
  });
  afterAll(async () => {
    if (!pool) return;
    await deleteSessions(pool, sessions);
    await pool.end();
  });

  // A session in the database, and its join code.
  async function session(langs: string[], status: "draft" | "live" | "ended" = "live") {
    const id = await insertSession(pool, langs, status === "ended" ? "live" : status);
    sessions.push(id);
    if (status === "ended") await pool.query("update sessions set status = 'ended', ended_at = now() where id = $1", [id]);
    const { rows } = await pool.query<{ join_code: string }>("select join_code from sessions where id = $1", [id]);
    return { id, code: rows[0]!.join_code };
  }

  const askToken = (code: string, lang: string, target = app) =>
    target.request(`/api/join/${code}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang }),
    });

  it("gives a listen-only token for the language's output room of a live session", async () => {
    const { id, code } = await session(["de", "fr"]);
    const res = await askToken(code, "fr");
    expect(res.status).toBe(200);
    const body = listenerTokenResponseSchema.parse(await res.json());
    expect(body.serverUrl).toBe(PUBLIC_URL);

    const claims = await readToken(body.token);
    expect(claims.sub).toMatch(/^listener-/);
    expect(claims.video).toMatchObject({
      room: `ses-${id}-fr-0`,
      roomJoin: true,
      canSubscribe: true,
      canPublish: false,
      canPublishData: false,
    });
  });

  it("gives each listener their own identity", async () => {
    const { code } = await session(["de"]);
    const first = listenerTokenResponseSchema.parse(await (await askToken(code, "de")).json());
    const second = listenerTokenResponseSchema.parse(await (await askToken(code, "de")).json());
    expect((await readToken(first.token)).sub).not.toBe((await readToken(second.token)).sub);
  });

  it("answers 404 for an unknown code, a draft or an ended session", async () => {
    const draft = await session(["de"], "draft");
    const ended = await session(["de"], "ended");
    for (const code of ["ZZZZZZ", draft.code, ended.code]) {
      const res = await askToken(code, "de");
      expect(res.status).toBe(404);
      expect(apiErrorSchema.parse(await res.json()).message).toBe("This session isn't live.");
    }
  });

  it("answers 400 for a language the session isn't translated into", async () => {
    const { code } = await session(["de"]);
    const res = await askToken(code, "fr");
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(await res.json()).message).toBe("This session isn't translated into that language.");
  });

  it("answers 501 without LiveKit", async () => {
    const { code } = await session(["de"]);
    const res = await askToken(code, "de", appWithoutLiveKit);
    expect(res.status).toBe(501);
  });
});
