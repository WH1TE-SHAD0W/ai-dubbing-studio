import { renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api.ts";
import { sendingText } from "./MicPicker.tsx";
import { useHostPublish } from "./useHostPublish.ts";

// Sending the host's microphone to the source room (YGP-105). LiveKit can't run
// in jsdom, so Room is a stand-in that writes down what it was asked to do.
const calls: string[] = [];
// What the stand-in room has published right now.
const published = new Set<string>();
let disconnectListener: ((reason?: number) => void) | null = null;

vi.mock("livekit-client", () => {
  class Room {
    localParticipant = {
      publishTrack: async (track: { id: string }) => {
        calls.push(`publish ${track.id}`);
        published.add(track.id);
      },
      unpublishTrack: async (track: { id: string }, stop: boolean) => {
        calls.push(`unpublish ${track.id}${stop ? " and stop" : ""}`);
        published.delete(track.id);
      },
    };
    on(_event: string, listener: (reason?: number) => void) {
      disconnectListener = listener;
      return this;
    }
    async connect(url: string, token: string) {
      calls.push(`connect ${url} ${token}`);
    }
    async disconnect() {
      calls.push("disconnect");
    }
  }
  return {
    Room,
    RoomEvent: { Disconnected: "disconnected" },
    Track: { Source: { Microphone: "microphone" } },
    DisconnectReason: { CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, ROOM_DELETED: 5 },
  };
});

// A microphone stream with one audio track. Like a real MediaStream, it hands
// out the same track object every time.
const micStream = (id: string) => {
  const tracks = [{ id }];
  return { getAudioTracks: () => tracks } as unknown as MediaStream;
};

beforeEach(() => {
  calls.length = 0;
  published.clear();
  disconnectListener = null;
  vi.spyOn(api, "getHostToken").mockResolvedValue({ serverUrl: "ws://lk.test", token: "host-token" });
});
afterEach(() => vi.restoreAllMocks());

describe("sending the host's microphone", () => {
  it("connects nowhere before the session is live", async () => {
    const stream = micStream("mic-a");
    const { result } = renderHook(() => useHostPublish("s1", false, stream));
    expect(result.current.status).toBe("idle");
    expect(api.getHostToken).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("publishes the microphone once live, and swaps the track when the input changes", async () => {
    const { result, rerender } = renderHook(({ stream }) => useHostPublish("s1", true, stream), {
      initialProps: { stream: micStream("mic-a") },
    });
    await waitFor(() => expect(result.current.status).toBe("sending"));
    expect(api.getHostToken).toHaveBeenCalledWith("s1");
    expect(calls).toEqual(["connect ws://lk.test host-token", "publish mic-a"]);

    rerender({ stream: micStream("mic-b") });
    await waitFor(() => expect([...published]).toEqual(["mic-b"]));
    // The old track is unpublished but left open: useMicrophone owns it.
    expect(calls).toContain("unpublish mic-a");
    expect(calls).not.toContain("unpublish mic-a and stop");
  });

  it("keeps the track published when React runs the effects twice (StrictMode)", async () => {
    const stream = micStream("mic-a");
    const { result } = renderHook(() => useHostPublish("s1", true, stream), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.status).toBe("sending"));
    // Let any delayed cleanup run, then check the track is still out there.
    await new Promise((r) => setTimeout(r, 0));
    expect([...published]).toEqual(["mic-a"]);
    expect(calls.filter((c) => c.startsWith("publish"))).toHaveLength(1);
  });

  it("stays connected but sends nothing while the microphone is off", async () => {
    const { result } = renderHook(() => useHostPublish("s1", true, null));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(calls).toEqual(["connect ws://lk.test host-token"]);
  });

  it("disconnects when the session ends", async () => {
    const stream = micStream("mic-a");
    const { result, rerender } = renderHook(({ live }) => useHostPublish("s1", live, stream), {
      initialProps: { live: true },
    });
    await waitFor(() => expect(result.current.status).toBe("sending"));
    rerender({ live: false });
    await waitFor(() => expect(calls).toContain("disconnect"));
    expect(result.current.status).toBe("idle");
  });

  it("says so when another device takes the microphone over", async () => {
    // Made once: a new stream on every render would look like a new microphone.
    const stream = micStream("mic-a");
    const { result } = renderHook(() => useHostPublish("s1", true, stream));
    await waitFor(() => expect(result.current.status).toBe("sending"));
    disconnectListener?.(2);
    await waitFor(() => expect(result.current).toEqual({ status: "error", message: "Your microphone is now being sent from another device." }));
  });
});

describe("the microphone's status line", () => {
  it("says what happens to the audio", () => {
    expect(sendingText(false, true, "idle")).toBe("Testing only: nothing is sent until you go live.");
    expect(sendingText(true, false, "connected")).toBe("Turn the microphone on to start sending.");
    expect(sendingText(true, true, "connecting")).toBe("Connecting to the audio server…");
    expect(sendingText(true, true, "sending")).toBe("● Sending to the translators");
  });
});
