import { DisconnectReason, Room, RoomEvent, Track } from "livekit-client";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";

// Sends the host's microphone to the session's source room (ADR-0020, YGP-105),
// where each language's worker hears it. While the session is live, the Studio
// keeps a connection to the source room with a publish-only token (YGP-71);
// while the microphone is also on, its track is published there. Switching the
// input swaps the track without reconnecting. When the session ends (or the
// host leaves the page), the connection closes and publishing stops.
//
// The microphone itself belongs to useMicrophone: this never stops its track.

export type PublishState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "connected" }
  | { status: "sending" }
  | { status: "error"; message: string };

export function useHostPublish(sessionId: string, live: boolean, stream: MediaStream | null): PublishState {
  const [room, setRoom] = useState<Room | null>(null);
  const [state, setState] = useState<PublishState>({ status: "idle" });
  // The connection that's open right now, so a publish that finishes after it
  // closed doesn't claim to be sending.
  const openRoom = useRef<Room | null>(null);

  // The connection: open while the session is live.
  useEffect(() => {
    if (!live) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    const r = new Room();
    r.on(RoomEvent.Disconnected, (reason) => {
      if (openRoom.current === r) openRoom.current = null;
      if (cancelled) return;
      setRoom(null);
      // The host's identity is fixed, so opening the Studio on a second device
      // takes the microphone over from this one (one mic per session).
      if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
        setState({ status: "error", message: "Your microphone is now being sent from another device." });
      } else if (reason !== DisconnectReason.ROOM_DELETED && reason !== DisconnectReason.CLIENT_INITIATED) {
        setState({ status: "error", message: "Lost the connection to the audio server. Reload the page to reconnect." });
      }
    });
    setState({ status: "connecting" });
    void (async () => {
      try {
        const { serverUrl, token } = await api.getHostToken(sessionId);
        if (cancelled) return;
        await r.connect(serverUrl, token);
        if (cancelled) {
          await r.disconnect();
          return;
        }
        openRoom.current = r;
        setRoom(r);
        setState({ status: "connected" });
      } catch {
        if (!cancelled) setState({ status: "error", message: "Couldn't connect to the audio server. Check your connection." });
      }
    })();
    return () => {
      cancelled = true;
      if (openRoom.current === r) openRoom.current = null;
      setRoom(null);
      void r.disconnect();
    };
  }, [sessionId, live]);

  // The track: published while connected and the microphone is on.
  //
  // React may run this effect's cleanup and then run it again for the same track
  // (StrictMode does that on every mount in development). So a cleanup doesn't
  // unpublish straight away: it waits until React has finished, and only
  // unpublishes if that track is no longer wanted. Each track is published at
  // most once per connection.
  const track = stream?.getAudioTracks()[0] ?? null;
  const wanted = useRef<MediaStreamTrack | null>(null);
  // Per connection: the tracks being published or published there.
  const publishing = useRef(new WeakMap<Room, Map<MediaStreamTrack, Promise<unknown>>>());
  useEffect(() => {
    if (!room || !track) {
      if (room) setState({ status: "connected" });
      return;
    }
    wanted.current = track;
    const inFlight = publishing.current.get(room) ?? new Map<MediaStreamTrack, Promise<unknown>>();
    publishing.current.set(room, inFlight);
    let pending = inFlight.get(track);
    if (!pending) {
      pending = room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, name: "host-mic" });
      inFlight.set(track, pending);
    }
    pending
      .then(() => {
        if (wanted.current === track && openRoom.current === room) setState({ status: "sending" });
      })
      .catch(() => {
        inFlight.delete(track);
        if (wanted.current === track) setState({ status: "error", message: "Couldn't send the microphone. Try turning it off and on." });
      });
    return () => {
      if (wanted.current === track) wanted.current = null;
      void Promise.resolve().then(async () => {
        if (wanted.current === track) return; // run again for the same track: keep it
        const published = inFlight.get(track);
        inFlight.delete(track);
        try {
          await published;
          // Keep the device open: useMicrophone owns it, and may be switching
          // to another input.
          await room.localParticipant.unpublishTrack(track, false);
        } catch {
          // Never published, or the connection is already gone.
        }
      });
    };
  }, [room, track]);

  return state;
}
