import { useMicrophone } from "./useMicrophone.ts";

export function MicPicker() {
  const mic = useMicrophone();
  const on = mic.state.status === "on";

  return (
    <section className="card" aria-labelledby="mic-heading">
      <h2 id="mic-heading">Microphone</h2>
      {mic.state.status === "error" && <p className="error" role="alert">{mic.state.message}</p>}

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
          {mic.state.status === "requesting" ? "Waiting for permission…" : "Test microphone"}
        </button>
      )}
      <p className="hint">How the microphone audio reaches the dubbing container is still to be decided, so nothing is sent yet.</p>
    </section>
  );
}
