import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  LiveKitError,
  createRoomService,
  outputRoomName,
  sourceRoomName,
} from "../src/livekit/rooms.ts";

// Room names (no server needed) and the room API against a real LiveKit
// (YGP-69). The second part needs LIVEKIT_URL, LIVEKIT_API_KEY and
// LIVEKIT_API_SECRET, for example the LiveKit from Docker Compose, and is
// skipped without them. Every test uses a new session ID, so its rooms never
// clash with real ones, and deletes them at the end.

describe("room names", () => {
  const id = "3f0c2b7e-0000-4000-8000-000000000001";

  it("names the source room after the session", () => {
    expect(sourceRoomName(id)).toBe(`ses-${id}-src`);
  });

  it("names each output room after the session, the language and the shard", () => {
    expect(outputRoomName(id, "de")).toBe(`ses-${id}-de-0`);
    expect(outputRoomName(id, "de", 2)).toBe(`ses-${id}-de-2`);
  });

  it("gives every session and language its own room", () => {
    const other = "3f0c2b7e-0000-4000-8000-000000000002";
    expect(outputRoomName(id, "de")).not.toBe(outputRoomName(other, "de"));
    expect(outputRoomName(id, "de")).not.toBe(outputRoomName(id, "fr"));
    expect(sourceRoomName(id)).not.toBe(outputRoomName(id, "en"));
  });
});

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
const configured = Boolean(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET);

describe.skipIf(!configured)("rooms against LiveKit", () => {
  const config = { url: LIVEKIT_URL ?? "", apiKey: LIVEKIT_API_KEY ?? "", apiSecret: LIVEKIT_API_SECRET ?? "" };
  const rooms = createRoomService(config);
  const sessions: string[] = [];
  const newSession = () => {
    const id = randomUUID();
    sessions.push(id);
    return id;
  };
  const roomsOf = async (sessionId: string) =>
    (await rooms.listRoomNames()).filter((name) => name.startsWith(`ses-${sessionId}-`)).sort();

  afterAll(async () => {
    for (const id of sessions) {
      await rooms.deleteSourceRoom(id);
      await rooms.deleteOutputRooms(id, ["en", "de", "fr"]);
    }
  });

  it("creates one source room and one output room per language", async () => {
    const id = newSession();
    const created = await rooms.createSessionRooms(id, ["de", "fr"]);

    expect(created).toEqual({
      source: `ses-${id}-src`,
      outputs: { de: `ses-${id}-de-0`, fr: `ses-${id}-fr-0` },
    });
    expect(await roomsOf(id)).toEqual([`ses-${id}-de-0`, `ses-${id}-fr-0`, `ses-${id}-src`]);
  });

  it("ends a session in two steps: the source room first, then the output rooms", async () => {
    const id = newSession();
    await rooms.createSessionRooms(id, ["de", "fr"]);

    await rooms.deleteSourceRoom(id);
    expect(await roomsOf(id)).toEqual([`ses-${id}-de-0`, `ses-${id}-fr-0`]);

    await rooms.deleteOutputRooms(id, ["de", "fr"]);
    expect(await roomsOf(id)).toEqual([]);
  });

  it("treats deleting rooms that are already gone as done", async () => {
    const id = newSession();
    await rooms.createSessionRooms(id, ["en"]);
    await rooms.deleteSourceRoom(id);
    await rooms.deleteOutputRooms(id, ["en"]);

    await expect(rooms.deleteSourceRoom(id)).resolves.toBeUndefined();
    await expect(rooms.deleteOutputRooms(id, ["en"])).resolves.toBeUndefined();
  });

  it("fails with a clear error and leaves no rooms behind when LiveKit refuses", async () => {
    const id = newSession();
    const wrongSecret = createRoomService({ ...config, apiSecret: "wrong-secret-".repeat(4) });

    const attempt = wrongSecret.createSessionRooms(id, ["de"]);
    await expect(attempt).rejects.toBeInstanceOf(LiveKitError);
    await expect(attempt).rejects.toThrow(`couldn't create the rooms for session ${id}`);
    expect(await roomsOf(id)).toEqual([]);
  });
});
