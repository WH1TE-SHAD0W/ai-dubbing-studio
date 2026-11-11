import { useEffect } from "react";

// Lock-screen metadata and controls (ADR-0011). Playback on a locked phone is a
// target, not a guarantee: the browser or battery saver may still suspend it.
export function useMediaSession(title: string, subtitle: string, onStop: () => void): void {
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    ms.metadata = new MediaMetadata({
      title,
      artist: subtitle,
      album: "AI Dubbing Studio",
      artwork: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
    });
    ms.playbackState = "playing";
    // Live audio can't be paused and resumed later, so "pause" stops listening.
    ms.setActionHandler("pause", onStop);
    ms.setActionHandler("stop", onStop);
    return () => {
      ms.metadata = null;
      ms.playbackState = "none";
      ms.setActionHandler("pause", null);
      ms.setActionHandler("stop", null);
    };
  }, [title, subtitle, onStop]);
}
