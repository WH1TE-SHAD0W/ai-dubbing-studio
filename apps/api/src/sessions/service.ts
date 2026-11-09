import type { CreateSessionRequest, JoinSessionResponse, LanguageCode, Session } from "@ads/contracts";
import type pg from "pg";
import type { RoomService } from "../livekit/rooms.ts";
import type { TrackService } from "../tracks/service.ts";
import * as repo from "./repo.ts";

// A session's life (ADR-0002) and its translation (ADR-0018): going live opens
// one translation track per target language and sends their jobs to the
// translator workers; ending it ends the tracks, so each worker stops at its
// next heartbeat. Start and end can be called again safely, as the app may
// retry them.
//
// With LiveKit configured (ADR-0020), going live first creates the session's
// rooms, so no worker gets a job for a room that doesn't exist, and ending
// deletes them. Without it, sessions work as before, without rooms.

export type SessionService = ReturnType<typeof createSessionService>;
export type SessionRoomService = Pick<RoomService, "createSessionRooms" | "deleteSourceRoom" | "deleteOutputRooms">;

export function createSessionService(
  pool: pg.Pool,
  tracks: Pick<TrackService, "openSession" | "endSession">,
  rooms?: SessionRoomService,
) {
  // Both rooms at once, not ADR-0020's two steps (source room, wait for the
  // workers to report ended, then the output rooms): there is no `ending`
  // status to wait in yet, and workers already stop at their next heartbeat.
  // A LiveKit failure here is only logged: the session has ended in Postgres,
  // and LiveKit closes the empty rooms itself after a few minutes.
  async function deleteRooms(service: SessionRoomService, id: string, langs: LanguageCode[]): Promise<void> {
    try {
      await service.deleteSourceRoom(id);
      await service.deleteOutputRooms(id, langs);
    } catch (err) {
      console.error(`sessions: ${id} ended, but deleting its LiveKit rooms failed:`, err instanceof Error ? err.message : err);
    }
  }

  return {
    async create(hostId: string, req: CreateSessionRequest): Promise<Session> {
      const session = await repo.createSession(pool, hostId, req);
      console.log(
        `sessions: ${session.id} created (code ${session.joinCode}, ${session.sourceLang} → ${req.targetLangs.join(", ")})`,
      );
      return session;
    },

    get: (hostId: string, id: string): Promise<Session | null> => repo.getSession(pool, hostId, id),

    // draft → live, then the rooms, then the tracks. Calling it on a live
    // session creates any missing room and opens any missing track (if the
    // first call failed half way) and sends any job that wasn't sent; it never
    // reopens an ended session. If LiveKit fails, the error goes to the caller
    // before any track opens, and the host's retry finishes the start.
    async start(hostId: string, id: string): Promise<Session | null> {
      const changed = await repo.markLive(pool, hostId, id);
      const session = await repo.getSession(pool, hostId, id);
      if (!session || session.status !== "live") return session;
      const langs = session.languages.map((l) => l.lang);
      if (changed) console.log(`sessions: ${id} is live; opening ${langs.length} translation track(s): ${langs.join(", ")}`);
      if (rooms) await rooms.createSessionRooms(id, langs);
      await tracks.openSession(id, langs);
      return repo.getSession(pool, hostId, id);
    },

    // draft or live → ended, every track with it, then the rooms.
    async end(hostId: string, id: string, reason = "host_ended"): Promise<Session | null> {
      const changed = await repo.markEnded(pool, hostId, id, reason);
      const session = await repo.getSession(pool, hostId, id);
      if (!session) return null;
      if (changed) console.log(`sessions: ${id} ended (${reason})`);
      await tracks.endSession(id);
      if (rooms) await deleteRooms(rooms, id, session.languages.map((l) => l.lang));
      return repo.getSession(pool, hostId, id);
    },

    join: (code: string): Promise<JoinSessionResponse | null> => repo.findByJoinCode(pool, code),
  };
}
