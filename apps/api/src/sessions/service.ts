import type { CreateSessionRequest, JoinSessionResponse, Session } from "@ads/contracts";
import type pg from "pg";
import type { TrackService } from "../tracks/service.ts";
import * as repo from "./repo.ts";

// A session's life (ADR-0002) and its translation (ADR-0018): going live opens
// one translation track per target language and sends their jobs to the
// translator workers; ending it ends the tracks, so each worker stops at its
// next heartbeat. Start and end can be called again safely, as the app may
// retry them.

export type SessionService = ReturnType<typeof createSessionService>;

export function createSessionService(pool: pg.Pool, tracks: Pick<TrackService, "openSession" | "endSession">) {
  return {
    async create(hostId: string, req: CreateSessionRequest): Promise<Session> {
      const session = await repo.createSession(pool, hostId, req);
      console.log(
        `sessions: ${session.id} created (code ${session.joinCode}, ${session.sourceLang} → ${req.targetLangs.join(", ")})`,
      );
      return session;
    },

    get: (hostId: string, id: string): Promise<Session | null> => repo.getSession(pool, hostId, id),

    // draft → live, then the tracks. Calling it on a live session opens any
    // track that is missing (if the first call failed half way) and sends any
    // job that wasn't sent; it never reopens an ended session.
    async start(hostId: string, id: string): Promise<Session | null> {
      const changed = await repo.markLive(pool, hostId, id);
      const session = await repo.getSession(pool, hostId, id);
      if (!session || session.status !== "live") return session;
      const langs = session.languages.map((l) => l.lang);
      if (changed) console.log(`sessions: ${id} is live; opening ${langs.length} translation track(s): ${langs.join(", ")}`);
      await tracks.openSession(id, langs);
      return repo.getSession(pool, hostId, id);
    },

    // draft or live → ended, and every track with it.
    async end(hostId: string, id: string, reason = "host_ended"): Promise<Session | null> {
      const changed = await repo.markEnded(pool, hostId, id, reason);
      const session = await repo.getSession(pool, hostId, id);
      if (!session) return null;
      if (changed) console.log(`sessions: ${id} ended (${reason})`);
      await tracks.endSession(id);
      return repo.getSession(pool, hostId, id);
    },

    join: (code: string): Promise<JoinSessionResponse | null> => repo.findByJoinCode(pool, code),
  };
}
