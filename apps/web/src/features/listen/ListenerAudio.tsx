import { LiveKitRoom, RoomAudioRenderer, StartAudio, useConnectionState } from "@livekit/components-react";
import type { ListenerTokenResponse } from "@ads/contracts";
import { ConnectionState } from "livekit-client";
import { useState } from "react";

// Plays the chosen language's LiveKit room (ADR-0013). RoomAudioRenderer attaches
// each track to an <audio> element, the media-element playback ADR-0011 asks for.
// The listener only subscribes: no microphone or camera is ever requested.
export function ListenerAudio({ connection }: { connection: ListenerTokenResponse }) {
  const [error, setError] = useState<string | null>(null);

  return (
    <LiveKitRoom
      serverUrl={connection.serverUrl}
      token={connection.token}
      connect
      audio={false}
      video={false}
      onError={() => setError("Couldn't connect to the audio server. Check your connection.")}
      onConnected={() => setError(null)}
    >
      <RoomAudioRenderer />
      <ConnectionStatus error={error} />
      {/* Browsers need a tap before they play sound. */}
      <StartAudio label="Tap to start audio" className="primary" />
    </LiveKitRoom>
  );
}

function ConnectionStatus({ error }: { error: string | null }) {
  const state = useConnectionState();
  if (error) return <p className="error" role="alert">{error}</p>;
  const text: Record<ConnectionState, string> = {
    [ConnectionState.Disconnected]: "Disconnected",
    [ConnectionState.Connecting]: "Connecting…",
    [ConnectionState.Connected]: "Listening",
    [ConnectionState.Reconnecting]: "Connection lost, reconnecting…",
    [ConnectionState.SignalReconnecting]: "Connection lost, reconnecting…",
  };
  return (
    <p className="status" role="status">
      <span className={`dot ${state === ConnectionState.Connected ? "dot-live" : ""}`} /> {text[state]}
    </p>
  );
}
