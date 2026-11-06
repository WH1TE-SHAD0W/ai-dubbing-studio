import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  apiErrorSchema,
  claimConflictSchema,
  claimResponseSchema,
  heartbeatResponseSchema,
  okSchema,
  ownerConflictSchema,
} from "@ads/contracts";
import { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../src/db.ts";
import { migrateSqlFiles } from "../src/migrate.ts";
import { internalRoutes } from "../src/routes/internal.ts";
import { createTrackService, type TrackService } from "../src/tracks/service.ts";
import { TRACKS_DATABASE_URL, ensureTracksDatabase } from "./db.ts";

// The translator workers' API over HTTP, against a real Postgres, checked
// against the shared contract (the Go worker's client is tested against the
// same OpenAPI document). Runs in its own database (see db.ts). The
// tracks made here are deleted at the end, so a running API never sends them
// to real workers.
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const TOKEN = "internal-token-".repeat(3);

describe.skipIf(!TRACKS_DATABASE_URL)("internal routes for the translator workers", () => {
  let pool: pg.Pool;
  let tracks: TrackService;
  let app: Hono;
  const sessions: string[] = [];

  beforeAll(async () => {
    await ensureTracksDatabase();
    pool = createPool(TRACKS_DATABASE_URL!);
    await migrateSqlFiles(pool, MIGRATIONS);
    tracks = createTrackService(pool, { send: async () => "1-0" }, { leaseTtlSec: 15, heartbeatSec: 5, maxAttempts: 3 });
    app = new Hono().route("/internal", internalRoutes({ token: TOKEN, tracks }));
  });
  afterAll(async () => {
    await pool?.query("delete from translation_tracks where session_id = any($1::uuid[])", [sessions]);
    await pool?.end();
  });

  function post(path: string, body: unknown, token: string | null = TOKEN) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
  }
  async function openTrack(lang = "sk") {
    const sessionId = randomUUID();
    sessions.push(sessionId);
    const [track] = await tracks.openSession(sessionId, [lang]);
    return { sessionId, trackId: track!.id };
  }

  it("need the shared token", async () => {
    const { trackId } = await openTrack();
    const body = { workerId: "w1", jobId: "j" };
    for (const token of [null, "wrong", `${TOKEN}x`]) {
      const res = await post(`/internal/tracks/${trackId}/claim`, body, token);
      expect(res.status).toBe(401);
      expect(apiErrorSchema.parse(await res.json()).message).toBe("Unauthorized.");
    }
  });

  it("check bodies against the contract", async () => {
    const { trackId } = await openTrack();
    expect((await post(`/internal/tracks/${trackId}/claim`, { jobId: "j" })).status).toBe(400);
    expect((await post(`/internal/tracks/${trackId}/heartbeat`, { workerId: "w1", state: "sleeping" })).status).toBe(400);
    expect((await post(`/internal/tracks/${trackId}/status`, { workerId: "w1", status: "claimed" })).status).toBe(400);
    expect((await post(`/internal/tracks/${trackId}/release`, { workerId: "w1", reason: "bored" })).status).toBe(400);
  });

  it("run a track from the claim to the session's end", async () => {
    const { sessionId, trackId } = await openTrack("de");

    const claimed = await post(`/internal/tracks/${trackId}/claim`, { workerId: "w1", jobId: "1-0" });
    expect(claimed.status).toBe(200);
    expect(claimResponseSchema.parse(await claimed.json())).toEqual({
      trackId,
      sessionId,
      language: "de",
      leaseTtlSec: 15,
      heartbeatSec: 5,
    });

    const beat = await post(`/internal/tracks/${trackId}/heartbeat`, { workerId: "w1", state: "connecting" });
    expect(heartbeatResponseSchema.parse(await beat.json())).toEqual({ leaseTtlSec: 15 });

    const live = await post(`/internal/tracks/${trackId}/status`, { workerId: "w1", status: "live" });
    expect(okSchema.parse(await live.json())).toEqual({ ok: true });

    // The host ends the session: the worker's next heartbeat tells it to stop.
    await tracks.endSession(sessionId);
    const stop = await post(`/internal/tracks/${trackId}/heartbeat`, {
      workerId: "w1",
      state: "live",
      stats: { inDroppedFrames: 0, outBufferMs: 80, geminiReconnects: 0 },
    });
    expect(stop.status).toBe(409);
    expect(ownerConflictSchema.parse(await stop.json()).reason).toBe("ended");
  });

  it("answer 409 with the reason the worker acts on", async () => {
    const unknown = await post(`/internal/tracks/${randomUUID()}/claim`, { workerId: "w1", jobId: "j" });
    expect(unknown.status).toBe(409);
    expect(claimConflictSchema.parse(await unknown.json())).toEqual({ reason: "unknown_track", message: "There is no such track." });

    const { trackId } = await openTrack();
    await post(`/internal/tracks/${trackId}/claim`, { workerId: "w1", jobId: "j" });
    const taken = await post(`/internal/tracks/${trackId}/claim`, { workerId: "w2", jobId: "j" });
    expect(claimConflictSchema.parse(await taken.json()).reason).toBe("owned");

    const notMine = await post(`/internal/tracks/${trackId}/status`, { workerId: "w2", status: "live" });
    expect(notMine.status).toBe(409);
    expect(ownerConflictSchema.parse(await notMine.json()).reason).toBe("not_owner");
  });

  it("give the track back on SIGTERM", async () => {
    const { trackId } = await openTrack();
    await post(`/internal/tracks/${trackId}/claim`, { workerId: "w1", jobId: "j" });
    const res = await post(`/internal/tracks/${trackId}/release`, { workerId: "w1", reason: "sigterm" });
    expect(res.status).toBe(200);
    const { rows } = await pool.query("select status, worker_id from translation_tracks where id = $1", [trackId]);
    expect(rows[0]).toEqual({ status: "pending", worker_id: null });
  });
});
