import type {
  ClaimConflictReason,
  ClaimResponse,
  OwnerConflictReason,
  ReportedStatus,
} from "@ads/contracts";
import type pg from "pg";
import type { JobSender } from "../queue/jobs.ts";
import * as repo from "./repo.ts";

// Translation tracks for the rest of the API: the internal routes the workers
// call, the sweeper, and (once sessions are stored) the session routes, which
// call openSession on /start and endSession on /end. Until then the dev CLI
// (src/cli/tracks.ts) does. Every change of owner is in Postgres first; the
// job goes on the stream after, and a job that couldn't be sent is sent by the
// sweeper later.

export type TrackSettings = {
  leaseTtlSec: number;
  heartbeatSec: number;
  maxAttempts: number;
};

export type TrackService = ReturnType<typeof createTrackService>;

type Conflict<R> = { ok: false; reason: R };

export function createTrackService(db: pg.Pool, jobs: JobSender, settings: TrackSettings) {
  const { leaseTtlSec, heartbeatSec, maxAttempts } = settings;

  // Puts the tracks' jobs on the stream and records it. One that fails stays
  // unsent (enqueued_at null), so the sweeper retries it within seconds.
  async function send(tracks: repo.TrackToSend[]): Promise<number> {
    const sent: string[] = [];
    for (const t of tracks) {
      try {
        await jobs.send({ sessionId: t.sessionId, trackId: t.id, language: t.lang });
        sent.push(t.id);
      } catch (err) {
        console.error(`tracks: can't send the job for track ${t.id} yet: ${err instanceof Error ? err.message : err}`);
        break; // Redis is most likely down; the sweeper tries again.
      }
    }
    await repo.markSent(db, sent);
    return sent.length;
  }

  // Sends the jobs of pending tracks that have none on the stream. With
  // staleAfterSec it also re-sends jobs sent that long ago and never claimed.
  async function sendPending(staleAfterSec: number | null = null): Promise<number> {
    return send(await repo.tracksToSend(db, staleAfterSec));
  }

  return {
    // Creates the session's tracks (one per target language) and sends their jobs.
    async openSession(sessionId: string, langs: string[]): Promise<repo.Track[]> {
      const tracks = await repo.openTracks(db, sessionId, langs);
      await send(tracks.filter((t) => t.status === "pending" && t.enqueuedAt === null));
      return repo.getTracks(db, sessionId);
    },

    // Ends the session's tracks; their workers stop at the next heartbeat.
    async endSession(sessionId: string, reason = "session_ended"): Promise<number> {
      const ended = await repo.endTracks(db, sessionId, reason);
      if (ended.length > 0) console.log(`tracks: session ${sessionId} ended, ${ended.length} track(s) stop`);
      return ended.length;
    },

    async claim(
      trackId: string,
      workerId: string,
      jobId: string,
    ): Promise<{ ok: true; claim: ClaimResponse } | Conflict<ClaimConflictReason>> {
      const result = await repo.claimTrack(db, trackId, workerId, leaseTtlSec);
      if (!result.ok) {
        console.log(`tracks: ${workerId} can't claim ${trackId} (job ${jobId}): ${result.reason}`);
        return result;
      }
      const t = result.track;
      console.log(`tracks: ${workerId} claimed ${t.id} (${t.lang}, session ${t.sessionId}, job ${jobId})`);
      return {
        ok: true,
        claim: { trackId: t.id, sessionId: t.sessionId, language: t.lang, leaseTtlSec, heartbeatSec },
      };
    },

    async heartbeat(trackId: string, workerId: string): Promise<{ ok: true; leaseTtlSec: number } | Conflict<OwnerConflictReason>> {
      const result = await repo.renewLease(db, trackId, workerId, leaseTtlSec);
      return result.ok ? { ok: true, leaseTtlSec } : result;
    },

    async report(
      trackId: string,
      workerId: string,
      status: ReportedStatus,
      reason: string | undefined,
    ): Promise<{ ok: true } | Conflict<OwnerConflictReason>> {
      if (status === "live") {
        const result = await repo.renewLease(db, trackId, workerId, leaseTtlSec, true);
        if (result.ok) console.log(`tracks: ${trackId} is live (${workerId})`);
        return result;
      }
      if (status === "ended") {
        const result = await repo.endTrack(db, trackId, workerId, reason ?? "worker_ended");
        if (result.ok) console.log(`tracks: ${workerId} ended ${trackId}: ${reason ?? "no reason given"}`);
        return result;
      }
      const result = await repo.failTrack(db, trackId, workerId, reason ?? "worker_failed", maxAttempts);
      if (!result.ok) return result;
      console.log(`tracks: ${workerId} failed on ${trackId}: ${reason ?? "no reason given"}${result.requeue ? "; trying another worker" : ""}`);
      if (result.requeue) await sendPending();
      return { ok: true };
    },

    async release(trackId: string, workerId: string, reason: string): Promise<{ ok: true } | Conflict<OwnerConflictReason>> {
      const result = await repo.releaseTrack(db, trackId, workerId, reason);
      if (!result.ok) return result;
      console.log(`tracks: ${workerId} released ${trackId} (${reason}); sending it to another worker`);
      await sendPending();
      return { ok: true };
    },

    // Sweeper: tracks whose worker vanished go back to pending (or failed).
    async expireLeases(): Promise<number> {
      const expired = await repo.expireLeases(db, maxAttempts);
      for (const t of expired) console.log(`tracks: lease on ${t.id} ran out; sending it to another worker`);
      await send(expired);
      return expired.length;
    },

    sendPending,

    list: (sessionId?: string) => repo.getTracks(db, sessionId),
  };
}
