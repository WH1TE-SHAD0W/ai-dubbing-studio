import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRoomService } from "../src/livekit/rooms.ts";
import { type SessionRoomService, createSessionService } from "../src/sessions/service.ts";
import type { TrackService } from "../src/tracks/service.ts";
import { TEST_DATABASE_URL, deleteSessions, insertSession, openTestDatabase } from "./db.ts";

// A session's LiveKit rooms follow its life (ADR-0020, YGP-69): going live
// creates them before the translation tracks open, and ending deletes them.
// The first part uses a stand-in for LiveKit, to check the order and what
// happens when LiveKit fails; it needs Postgres. The second part uses a real
// LiveKit (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET), as in CI.

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
const livekitConfigured = Boolean(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET);

describe.skipIf(!TEST_DATABASE_URL)("a session's LiveKit rooms", () => {
  let pool: pg.Pool;
  const sessions: string[] = [];

  beforeAll(async () => {
    pool = await openTestDatabase();
  });
  afterAll(async () => {
    if (!pool) return;
    await deleteSessions(pool, sessions);
    await pool.end();
  });

  // A draft session with these languages, and its host.
  async function draftSession(langs: string[]) {
    const id = await insertSession(pool, langs, "draft");
    sessions.push(id);
    const { rows } = await pool.query<{ host_id: string }>("select host_id from sessions where id = $1", [id]);
    return { id, hostId: rows[0]!.host_id };
  }

  // Stand-ins that write down what was called, in order.
  function recorder(failRooms: { create?: boolean; delete?: boolean } = {}) {
    const calls: string[] = [];
    const tracks: Pick<TrackService, "openSession" | "endSession"> = {
      openSession: async (_id, langs) => {
        calls.push(`tracks.open ${langs.join(",")}`);
        return [];
      },
      endSession: async () => {
        calls.push("tracks.end");
        return 0;
      },
    };
    const rooms: SessionRoomService = {
      createSessionRooms: async (_id, langs) => {
        calls.push(`rooms.create ${langs.join(",")}`);
        if (failRooms.create) throw new Error("LiveKit is down");
        return { source: "", outputs: {} };
      },
      deleteSourceRoom: async () => {
        calls.push("rooms.deleteSource");
        if (failRooms.delete) throw new Error("LiveKit is down");
      },
      deleteOutputRooms: async (_id, langs) => {
        calls.push(`rooms.deleteOutputs ${langs.join(",")}`);
      },
    };
    return { calls, tracks, rooms };
  }

  it("creates the rooms before the tracks open, and deletes them after the tracks end", async () => {
    const { id, hostId } = await draftSession(["de", "fr"]);
    const { calls, tracks, rooms } = recorder();
    const service = createSessionService(pool, tracks, rooms);

    expect((await service.start(hostId, id))?.status).toBe("live");
    expect((await service.end(hostId, id))?.status).toBe("ended");
    expect(calls).toEqual([
      "rooms.create de,fr",
      "tracks.open de,fr",
      "tracks.end",
      "rooms.deleteSource",
      "rooms.deleteOutputs de,fr",
    ]);
  });

  it("opens no track when LiveKit fails on start, and the retry finishes the start", async () => {
    const { id, hostId } = await draftSession(["de"]);
    const failing = recorder({ create: true });
    await expect(createSessionService(pool, failing.tracks, failing.rooms).start(hostId, id)).rejects.toThrow(
      "LiveKit is down",
    );
    expect(failing.calls).toEqual(["rooms.create de"]);

    const working = recorder();
    expect((await createSessionService(pool, working.tracks, working.rooms).start(hostId, id))?.status).toBe("live");
    expect(working.calls).toEqual(["rooms.create de", "tracks.open de"]);
  });

  it("still ends the session when LiveKit fails on end, and logs it", async () => {
    const { id, hostId } = await draftSession(["de"]);
    const { tracks, rooms } = recorder({ delete: true });
    const service = createSessionService(pool, tracks, rooms);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await service.end(hostId, id))?.status).toBe("ended");
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("deleting its LiveKit rooms failed"), "LiveKit is down");
    } finally {
      logged.mockRestore();
    }
  });

  it("makes no LiveKit calls without LiveKit", async () => {
    const { id, hostId } = await draftSession(["de"]);
    const { calls, tracks } = recorder();
    const service = createSessionService(pool, tracks);
    await service.start(hostId, id);
    await service.end(hostId, id);
    expect(calls).toEqual(["tracks.open de", "tracks.end"]);
  });

  describe.skipIf(!livekitConfigured)("against LiveKit", () => {
    const rooms = createRoomService({
      url: LIVEKIT_URL ?? "",
      apiKey: LIVEKIT_API_KEY ?? "",
      apiSecret: LIVEKIT_API_SECRET ?? "",
    });
    const roomsOf = async (sessionId: string) =>
      (await rooms.listRoomNames()).filter((name) => name.startsWith(`ses-${sessionId}-`)).sort();

    it("has the source room and one output room per language while live, and none after the end", async () => {
      const { id, hostId } = await draftSession(["de", "fr"]);
      const { tracks } = recorder();
      const service = createSessionService(pool, tracks, rooms);

      await service.start(hostId, id);
      expect(await roomsOf(id)).toEqual([`ses-${id}-de-0`, `ses-${id}-fr-0`, `ses-${id}-src`]);

      await service.end(hostId, id);
      expect(await roomsOf(id)).toEqual([]);
    });
  });
});
