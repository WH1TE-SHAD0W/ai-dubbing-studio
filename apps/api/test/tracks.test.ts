import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "../src/db.ts";
import { migrateSqlFiles } from "../src/migrate.ts";
import type { JobToSend } from "../src/queue/jobs.ts";
import { createTrackService, type TrackService } from "../src/tracks/service.ts";
import { startSweeper } from "../src/tracks/sweeper.ts";
import { TRACKS_DATABASE_URL, ensureTracksDatabase } from "./db.ts";

// Translation tracks against a real Postgres (ADR-0002: queries need a real
// database): who owns a track, its lease, and the sweeper. Redis is replaced by
// an in-memory sender. Runs in a database of its own (see db.ts), skipped
// without DATABASE_URL or TEST_DATABASE_URL. The sweeper works on the whole
// table, so assertions only look at the tracks each test made; those are
// deleted at the end.
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

function fakeJobs() {
  const sent: JobToSend[] = [];
  return {
    sent,
    down: false,
    async send(job: JobToSend) {
      if (this.down) throw new Error("redis is down");
      sent.push(job);
      return `${sent.length}-0`;
    },
  };
}

describe.skipIf(!TRACKS_DATABASE_URL)("translation tracks against Postgres", () => {
  let pool: pg.Pool;
  let jobs: ReturnType<typeof fakeJobs>;
  let tracks: TrackService;
  const sessions: string[] = [];
  const newSession = () => {
    const id = randomUUID();
    sessions.push(id);
    return id;
  };

  beforeAll(async () => {
    await ensureTracksDatabase();
    pool = createPool(TRACKS_DATABASE_URL!);
    await migrateSqlFiles(pool, MIGRATIONS);
  });
  afterAll(async () => {
    await pool?.query("delete from translation_tracks where session_id = any($1::uuid[])", [sessions]);
    await pool?.end();
  });
  beforeEach(() => {
    jobs = fakeJobs();
    tracks = createTrackService(pool, jobs, { leaseTtlSec: 15, heartbeatSec: 5, maxAttempts: 3 });
  });

  async function openOne(lang = "sk") {
    const sessionId = newSession();
    const [track] = await tracks.openSession(sessionId, [lang]);
    return { sessionId, trackId: track!.id };
  }
  async function row(trackId: string) {
    const { rows } = await pool.query(
      `select status, worker_id as "workerId", attempts, reason, enqueued_at as "enqueuedAt", lease_until as "leaseUntil"
       from translation_tracks where id = $1`,
      [trackId],
    );
    return rows[0] as { status: string; workerId: string | null; attempts: number; reason: string | null; enqueuedAt: Date | null; leaseUntil: Date | null };
  }
  async function expireLease(trackId: string) {
    await pool.query(`update translation_tracks set lease_until = now() - interval '1 second' where id = $1`, [trackId]);
  }
  const jobsFor = (trackId: string) => jobs.sent.filter((j) => j.trackId === trackId);
  const claim = (trackId: string, workerId: string) => tracks.claim(trackId, workerId, "job-1");

  describe("a session's tracks", () => {
    it("are pending, one per language, each with its job sent once", async () => {
      const sessionId = newSession();
      const opened = await tracks.openSession(sessionId, ["sk", "de"]);
      expect(opened.map((t) => [t.lang, t.status])).toEqual([
        ["de", "pending"],
        ["sk", "pending"],
      ]);
      expect(opened.every((t) => t.enqueuedAt !== null)).toBe(true);
      expect(jobs.sent.filter((j) => j.sessionId === sessionId).map((j) => j.language).sort()).toEqual(["de", "sk"]);

      // Opening again changes nothing and sends nothing.
      await tracks.openSession(sessionId, ["sk", "de"]);
      expect(jobs.sent.filter((j) => j.sessionId === sessionId)).toHaveLength(2);
    });

    it("stay unsent while Redis is down, and the next pass sends them", async () => {
      jobs.down = true;
      const { trackId } = await openOne();
      expect((await row(trackId)).enqueuedAt).toBeNull();

      jobs.down = false;
      await tracks.sendPending();
      expect(jobsFor(trackId)).toHaveLength(1);
      expect((await row(trackId)).enqueuedAt).not.toBeNull();
    });

    it("end with the session; the owner is kept so its next call reads ended", async () => {
      const { sessionId, trackId } = await openOne();
      expect((await claim(trackId, "w1")).ok).toBe(true);

      expect(await tracks.endSession(sessionId)).toBe(1);
      expect(await row(trackId)).toMatchObject({ status: "ended", workerId: "w1", reason: "session_ended", leaseUntil: null });
      expect(await tracks.heartbeat(trackId, "w1")).toEqual({ ok: false, reason: "ended" });
      expect(await claim(trackId, "w2")).toEqual({ ok: false, reason: "ended" });
      expect(await tracks.endSession(sessionId)).toBe(0);
    });
  });

  describe("claiming", () => {
    it("gives a track to exactly one of many workers at once", async () => {
      const { trackId } = await openOne();
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(trackId, `racer-${i}`)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.reason)).toEqual(Array(7).fill("owned"));
    });

    it("answers a retried claim by the owner with the same track and settings", async () => {
      const { sessionId, trackId } = await openOne("de");
      const first = await claim(trackId, "w1");
      const again = await claim(trackId, "w1");
      expect(first).toEqual(again);
      expect(first).toEqual({
        ok: true,
        claim: { trackId, sessionId, language: "de", leaseTtlSec: 15, heartbeatSec: 5 },
      });
      expect((await row(trackId)).attempts).toBe(0);
    });

    it("answers unknown_track for ids that don't exist or aren't uuids", async () => {
      expect(await claim(randomUUID(), "w1")).toEqual({ ok: false, reason: "unknown_track" });
      expect(await claim("not-a-uuid", "w1")).toEqual({ ok: false, reason: "unknown_track" });
      expect(await tracks.heartbeat("not-a-uuid", "w1")).toEqual({ ok: false, reason: "not_owner" });
    });

    it("takes over an expired lease, counting the lost worker as an attempt", async () => {
      const { trackId } = await openOne();
      await claim(trackId, "w1");
      expect(await claim(trackId, "w2")).toEqual({ ok: false, reason: "owned" });

      await expireLease(trackId);
      expect((await claim(trackId, "w2")).ok).toBe(true);
      expect(await row(trackId)).toMatchObject({ status: "claimed", workerId: "w2", attempts: 1 });
      expect(await tracks.heartbeat(trackId, "w1")).toEqual({ ok: false, reason: "not_owner" });
    });
  });

  describe("while a worker has the track", () => {
    it("heartbeats renew the lease, for the owner only", async () => {
      const { trackId } = await openOne();
      await claim(trackId, "w1");
      await pool.query(`update translation_tracks set lease_until = now() + interval '2 seconds' where id = $1`, [trackId]);

      expect(await tracks.heartbeat(trackId, "w1")).toEqual({ ok: true, leaseTtlSec: 15 });
      const left = (await row(trackId)).leaseUntil!.getTime() - Date.now();
      expect(left).toBeGreaterThan(10_000);
      expect(await tracks.heartbeat(trackId, "w2")).toEqual({ ok: false, reason: "not_owner" });
    });

    it("goes live on the worker's report, and stays live on a retried claim", async () => {
      const { trackId } = await openOne();
      await claim(trackId, "w1");
      expect(await tracks.report(trackId, "w1", "live", undefined)).toEqual({ ok: true });
      expect((await row(trackId)).status).toBe("live");
      await claim(trackId, "w1");
      expect((await row(trackId)).status).toBe("live");
    });

    it("ends on the worker's own report; a retry is fine, another worker reads ended", async () => {
      const { trackId } = await openOne();
      await claim(trackId, "w1");
      expect(await tracks.report(trackId, "w1", "ended", "max_duration")).toEqual({ ok: true });
      expect(await row(trackId)).toMatchObject({ status: "ended", reason: "max_duration", leaseUntil: null });
      expect(await tracks.report(trackId, "w1", "ended", "max_duration")).toEqual({ ok: true });
      expect(await tracks.report(trackId, "w2", "ended", undefined)).toEqual({ ok: false, reason: "ended" });
    });

    it("goes to another worker when one fails, until the attempts run out", async () => {
      const { trackId } = await openOne();
      for (const [i, worker] of ["w1", "w2"].entries()) {
        await claim(trackId, worker);
        expect(await tracks.report(trackId, worker, "failed", "gemini: retries exhausted")).toEqual({ ok: true });
        expect(await row(trackId)).toMatchObject({ status: "pending", workerId: null, attempts: i + 1 });
        expect(jobsFor(trackId)).toHaveLength(i + 2);
      }

      await claim(trackId, "w3");
      expect(await tracks.report(trackId, "w3", "failed", "gemini: retries exhausted")).toEqual({ ok: true });
      expect(await row(trackId)).toMatchObject({ status: "failed", workerId: "w3", attempts: 3 });
      expect(jobsFor(trackId)).toHaveLength(3); // no new job for a failed track
      expect(await tracks.report(trackId, "w3", "failed", "retry")).toEqual({ ok: true });
      expect(await claim(trackId, "w4")).toEqual({ ok: false, reason: "ended" });
    });

    it("is given back on SIGTERM at once, without counting an attempt", async () => {
      const { trackId } = await openOne();
      await claim(trackId, "w1");
      expect(await tracks.release(trackId, "w1", "sigterm")).toEqual({ ok: true });
      expect(await row(trackId)).toMatchObject({ status: "pending", workerId: null, attempts: 0, reason: "sigterm" });
      expect(jobsFor(trackId)).toHaveLength(2);
      expect(await tracks.heartbeat(trackId, "w1")).toEqual({ ok: false, reason: "not_owner" });
      expect(await tracks.release(trackId, "w1", "sigterm")).toEqual({ ok: false, reason: "not_owner" });
    });
  });

  describe("the sweeper", () => {
    function sweeper(backlog: number | null) {
      const removed: number[] = [];
      const s = startSweeper({
        tracks,
        queue: {
          backlog: async () => backlog,
          removeIdleConsumers: async (idleMs) => {
            removed.push(idleMs);
            return [];
          },
        },
        everyMs: 60_000,
        consumerIdleMs: 0,
      });
      return { s, removed };
    }

    it("takes tracks back from vanished workers and sends their jobs again", async () => {
      const { trackId } = await openOne();
      await claim(trackId, "w1");
      await expireLease(trackId);

      const { s, removed } = sweeper(0);
      await s.runOnce();
      await s.stop();
      expect(await row(trackId)).toMatchObject({ status: "pending", workerId: null, attempts: 1, reason: "lease_expired" });
      expect(jobsFor(trackId)).toHaveLength(2);
      expect(removed).toEqual([0]);
    });

    it("fails a track whose workers keep vanishing", async () => {
      const { trackId } = await openOne();
      for (const worker of ["w1", "w2", "w3"]) {
        expect((await claim(trackId, worker)).ok).toBe(true);
        await expireLease(trackId);
        await tracks.expireLeases();
      }
      expect(await row(trackId)).toMatchObject({ status: "failed", attempts: 3, reason: "lease_expired" });
    });

    it("re-sends an unclaimed job only when every message has been delivered", async () => {
      const { trackId } = await openOne();
      await pool.query(`update translation_tracks set enqueued_at = now() - interval '1 minute' where id = $1`, [trackId]);

      // Messages still wait for a free worker: the job is most likely among them.
      const busy = sweeper(4);
      await busy.s.runOnce();
      await busy.s.stop();
      expect(jobsFor(trackId)).toHaveLength(1);

      // Nothing waits, yet nobody claimed it: the message was lost.
      const idle = sweeper(0);
      await idle.s.runOnce();
      await idle.s.stop();
      expect(jobsFor(trackId)).toHaveLength(2);
      const sentAgo = Date.now() - (await row(trackId)).enqueuedAt!.getTime();
      expect(sentAgo).toBeLessThan(10_000);
    });
  });
});
