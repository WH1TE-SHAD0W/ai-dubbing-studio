import { LiveKitRoom, RoomAudioRenderer, StartAudio, useConnectionState } from "@livekit/components-react";
import type { ListenerTokenResponse } from "@ads/contracts";
import { ConnectionState, DisconnectReason } from "livekit-client";
import { useState } from "react";

// Plays the chosen language's LiveKit room (ADR-0013). RoomAudioRenderer attaches
// each track to an <audio> element, the media-element playback ADR-0011 asks for.
// The listener only subscribes: no microphone or camera is ever requested.
//
// When the host ends the session, the API deletes its rooms (YGP-69), so LiveKit
// disconnects the listener with ROOM_DELETED: that's onEnded, not a lost
// connection.
export function ListenerAudio({
  connection,
  volume,
  muted,
  onEnded,
}: {
  connection: ListenerTokenResponse;
  volume: number;
  muted: boolean;
  onEnded: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [everConnected, setEverConnected] = useState(false);

  return (
    <LiveKitRoom
      serverUrl={connection.serverUrl}
      token={connection.token}
      connect
      audio={false}
      video={false}
      onError={() => setError("Couldn't connect to the audio server. Check your connection.")}
      onConnected={() => {
        setError(null);
        setEverConnected(true);
      }}
      onDisconnected={(reason) => {
        if (reason === DisconnectReason.ROOM_DELETED) onEnded();
      }}
    >
      <RoomAudioRenderer volume={volume} muted={muted} />
      <ConnectionStatus error={error} everConnected={everConnected} />
      {/* Browsers need a tap before they play sound. */}
      <StartAudio label="Tap to start audio" className="primary" />
    </LiveKitRoom>
  );
}

// What the listener sees. Before the first connection the room reports
// "disconnected" for a moment, which would read as an error: say "Connecting…".
export function statusText(state: ConnectionState, everConnected: boolean): string {
  switch (state) {
    case ConnectionState.Connected:
      return "Listening";
    case ConnectionState.Connecting:
      return "Connecting…";
    case ConnectionState.Reconnecting:
    case ConnectionState.SignalReconnecting:
      return "Connection lost, reconnecting…";
    case ConnectionState.Disconnected:
      return everConnected ? "Disconnected" : "Connecting…";
  }
}

function ConnectionStatus({ error, everConnected }: { error: string | null; everConnected: boolean }) {
  const state = useConnectionState();
  if (error) return <p className="error" role="alert">{error}</p>;
  return (
    <p className="status" role="status">
      <span className={`dot ${state === ConnectionState.Connected ? "dot-live" : ""}`} /> {statusText(state, everConnected)}
    </p>
  );
}
