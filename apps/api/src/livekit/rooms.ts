import type { LanguageCode } from "@ads/contracts";
import { RoomServiceClient, ServerError } from "livekit-server-sdk";

// The LiveKit rooms of a session (ADR-0020, YGP-69). Hono creates them all when
// the session starts: one source room, where the host publishes their mic once,
// and one output room per target language, where that language's worker
// publishes the dub and listeners subscribe.

export type LiveKitConfig = { url: string; apiKey: string; apiSecret: string };

// Names are worked out from the session and language, so any part of the system
// can find a room without asking. The last part of an output room's name is the
// shard: always 0 for now, kept so a busy language can later be split across rooms.
export function sourceRoomName(sessionId: string): string {
  return `ses-${sessionId}-src`;
}

export function outputRoomName(sessionId: string, language: LanguageCode, shard = 0): string {
  return `ses-${sessionId}-${language}-${shard}`;
}

export type SessionRooms = {
  source: string;
  outputs: Partial<Record<LanguageCode, string>>;
};

// How long LiveKit keeps a room that nobody is in. Hono deletes rooms itself
// when a session ends, so these only stop LiveKit closing a room early:
const EMPTY_TIMEOUT_S = 10 * 60; // before anyone has joined (workers take a moment)
const DEPARTURE_TIMEOUT_S = 5 * 60; // after the last person left (longer than the
// 60 s the host may be gone before Hono ends the session, ADR-0020)

export class LiveKitError extends Error {}

export function createRoomService(config: LiveKitConfig) {
  // The room API is HTTP, so ws:// and wss:// become http:// and https://.
  const host = config.url.replace(/^ws/, "http");
  const client = new RoomServiceClient(host, config.apiKey, config.apiSecret);

  const create = (name: string) =>
    client.createRoom({ name, emptyTimeout: EMPTY_TIMEOUT_S, departureTimeout: DEPARTURE_TIMEOUT_S });

  // Deleting a room that is already gone counts as done, so ending a session
  // twice (or after LiveKit closed a room) is safe.
  async function remove(name: string): Promise<void> {
    try {
      await client.deleteRoom(name);
    } catch (err) {
      if (err instanceof ServerError && (err.status === 404 || err.code === "not_found")) return;
      throw err;
    }
  }

  return {
    // Creates the source room and one output room per language. If any of them
    // fails, the ones already made are deleted again and the error says which
    // session it was, so the caller can fail the session instead of leaving
    // half its rooms behind.
    async createSessionRooms(sessionId: string, languages: readonly LanguageCode[]): Promise<SessionRooms> {
      const rooms: SessionRooms = { source: sourceRoomName(sessionId), outputs: {} };
      for (const language of languages) rooms.outputs[language] = outputRoomName(sessionId, language);
      const names = [rooms.source, ...Object.values(rooms.outputs)];

      const results = await Promise.allSettled(names.map(create));
      const failed = results.find((r) => r.status === "rejected");
      if (failed) {
        await Promise.allSettled(names.map(remove));
        const reason = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
        throw new LiveKitError(`livekit: couldn't create the rooms for session ${sessionId}: ${reason}`, {
          cause: failed.reason,
        });
      }
      return rooms;
    },

    // Step one of ending a session (ADR-0020): workers see the source room
    // close, stop translating and report their tracks ended.
    async deleteSourceRoom(sessionId: string): Promise<void> {
      await remove(sourceRoomName(sessionId));
    },

    // Step two, once the tracks have ended: this also disconnects the listeners.
    async deleteOutputRooms(sessionId: string, languages: readonly LanguageCode[]): Promise<void> {
      await Promise.all(languages.map((language) => remove(outputRoomName(sessionId, language))));
    },

    // The names of the rooms LiveKit has open right now, for checks and tests.
    async listRoomNames(): Promise<string[]> {
      return (await client.listRooms()).map((room) => room.name);
    },
  };
}

export type RoomService = ReturnType<typeof createRoomService>;
