import type { SessionStatus } from "@ads/contracts";
import { useHostPublish } from "./useHostPublish.ts";
import { useMicrophone } from "./useMicrophone.ts";

// The host's microphone: pick the input, see its level, and, while the session
// is live, send it to the translators through LiveKit (YGP-105). The host turns
// the microphone on themselves, so there's never a surprise permission prompt.
// Without a session (on the create form) it only tests the microphone.
export function MicPicker({ sessionId = "", status = "draft" }: { sessionId?: string; status?: SessionStatus }) {
  const mic = useMicrophone();
  const on = mic.state.status === "on";
  const live = status === "live";
  const publish = useHostPublish(sessionId, live, mic.state.status === "on" ? mic.state.stream : null);

  return (
    <section className="card" aria-labelledby="mic-heading">
      <h2 id="mic-heading">Microphone</h2>
      {mic.state.status === "error" && <p className="error" role="alert">{mic.state.message}</p>}
      {publish.status === "error" && <p className="error" role="alert">{publish.message}</p>}

      {mic.devices.length > 0 && (
        <label className="field">
          <span>Input</span>
          <select value={mic.deviceId ?? ""} onChange={(e) => mic.select(e.target.value)}>
            {mic.devices.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Microphone ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(mic.level * 100)}>
        <div className="meter-fill" style={{ transform: `scaleX(${mic.level})` }} />
      </div>

      {on ? (
        <button type="button" className="secondary" onClick={mic.stop}>
          Turn microphone off
        </button>
      ) : (
        <button type="button" className="secondary" onClick={() => void mic.start()} disabled={mic.state.status === "requesting"}>
          {mic.state.status === "requesting" ? "Waiting for permission…" : live ? "Turn microphone on" : "Test microphone"}
        </button>
      )}
      <p className="hint" role="status">
        {sendingText(live, on, publish.status)}
      </p>
    </section>
  );
}

// What happens to the microphone audio right now.
export function sendingText(live: boolean, micOn: boolean, publish: ReturnType<typeof useHostPublish>["status"]): string {
  if (!live) return micOn ? "Testing only: nothing is sent until you go live." : "Nothing is sent until you go live.";
  if (!micOn) return "Turn the microphone on to start sending.";
  if (publish === "sending") return "● Sending to the translators";
  if (publish === "error") return "Not sending.";
  return "Connecting to the audio server…";
}
