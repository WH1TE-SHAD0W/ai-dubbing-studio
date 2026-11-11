import { useCallback, useEffect, useRef, useState } from "react";

// The host's microphone: device picker and level meter (ADR-0011). How the audio
// then reaches the dubbing container is still to be decided, so this only opens the
// device and exposes the stream for whichever transport is chosen.

const STORAGE_KEY = "ads.mic";

export type MicState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "on"; stream: MediaStream }
  | { status: "error"; message: string };

function readSaved(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function save(deviceId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, deviceId);
  } catch {
    // Storage can be blocked (private mode); the choice just isn't remembered.
  }
}

function describe(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") return "Microphone access was blocked. Allow it in the browser's site settings.";
    if (error.name === "NotFoundError") return "No microphone found.";
    if (error.name === "NotReadableError") return "The microphone is in use by another app.";
  }
  if (!window.isSecureContext) return "The microphone needs HTTPS (or localhost).";
  return "Couldn't open the microphone.";
}

export function useMicrophone() {
  const [state, setState] = useState<MicState>({ status: "idle" });
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>(readSaved);
  const [level, setLevel] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);

  const refreshDevices = useCallback(async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    setDevices(all.filter((d) => d.kind === "audioinput"));
  }, []);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setState({ status: "idle" });
    setLevel(0);
  }, []);

  // Nothing is requested until the host taps, so there is no surprise permission prompt.
  const start = useCallback(
    async (id: string | undefined = deviceId) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setState({ status: "error", message: describe(undefined) });
        return;
      }
      setState({ status: "requesting" });
      try {
        // Open the new input before releasing the old one, so switching has no gap.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: id ? { deviceId: { exact: id } } : true,
        });
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = stream;
        const actual = stream.getAudioTracks()[0]?.getSettings().deviceId;
        if (actual) {
          setDeviceId(actual);
          save(actual);
        }
        setState({ status: "on", stream });
        await refreshDevices(); // labels only appear once permission is granted
      } catch (error) {
        setState({ status: "error", message: describe(error) });
      }
    },
    [deviceId, refreshDevices],
  );

  const select = useCallback(
    (id: string) => {
      setDeviceId(id);
      save(id);
      if (streamRef.current) void start(id);
    },
    [start],
  );

  // Level meter: RMS of the input, 0..1, updated every animation frame.
  useEffect(() => {
    if (state.status !== "on") return;
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(state.stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let frame = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      void ctx.close();
    };
  }, [state]);

  // A device was plugged in or removed (e.g. Bluetooth).
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md) return;
    md.addEventListener("devicechange", refreshDevices);
    return () => md.removeEventListener("devicechange", refreshDevices);
  }, [refreshDevices]);

  // Release the device when the Studio unmounts.
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  return { state, devices, deviceId, level, start, stop, select };
}
