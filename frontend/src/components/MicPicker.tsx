import type { ReactNode } from 'react'
import { useLive } from '../live'
import { SPEECH_LEVEL, type MicState } from '../live/mic'
import type { Store } from '../live/types'

/** Loudness bar with a tick where speech starts to count. Subscribes on its own so only it re-renders ~10 times a second. */
export function MicMeter({ level }: { level: Store<{ level: number }> }) {
  const { level: v } = useLive(level)
  return (
    <div
      className="meter"
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
    >
      <div className={`meter__fill${v >= SPEECH_LEVEL ? ' meter__fill--hot' : ''}`} style={{ width: `${v * 100}%` }} />
      <span className="meter__mark" style={{ left: `${SPEECH_LEVEL * 100}%` }} aria-hidden="true" />
    </div>
  )
}

/** What to tell the host when nothing speech-like has been heard. */
export function silentHint(mic: MicState): string {
  const base = 'We can’t hear anything on this microphone. Check the input above, or the microphone’s mute switch.'
  return mic.processing ? `${base} Playing sound from a mixer, virtual cable or video? Turn voice cleanup off.` : base
}

interface Props {
  mic: MicState
  level: Store<{ level: number }>
  onSelect: (choice: string) => void
  /** Turn the browser's voice cleanup on or off. Omit to hide the switch. */
  onProcessing?: (on: boolean) => void
  /** Context-specific guidance under the meter (a silence warning in the studio, "say something" in the test). */
  hint?: ReactNode
  id?: string
}

/** Input picker plus level meter. Presentational: every state can be rendered from props. */
export function MicPicker({ mic, level, onSelect, onProcessing, hint, id = 'mic-select' }: Props) {
  const known = mic.devices.some((d) => d.id === mic.choice)
  return (
    <div className="mic-picker">
      <div className="field">
        <label className="label" htmlFor={id}>
          Microphone input
        </label>
        <select
          id={id}
          className="select"
          value={mic.choice}
          disabled={mic.switching || mic.status !== 'on'}
          onChange={(e) => onSelect(e.target.value)}
        >
          <option value="">{mic.choice === '' && mic.activeLabel ? `System default (${mic.activeLabel})` : 'System default'}</option>
          {mic.choice && !known && <option value={mic.choice}>{mic.activeLabel ?? 'Selected microphone'}</option>}
          {mic.devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      <MicMeter level={level} />

      {onProcessing && (
        <label className="mic-processing">
          <input
            type="checkbox"
            checked={mic.processing}
            disabled={mic.switching || mic.status !== 'on'}
            onChange={(e) => onProcessing(e.target.checked)}
          />
          <span>
            Voice cleanup <small className="muted">(echo cancellation, noise suppression, auto volume)</small>
          </span>
        </label>
      )}

      <div aria-live="polite" className="mic-notes">
        {mic.switching && <p className="muted small">Switching…</p>}
        {mic.notice && <p className="small mic-notice">{mic.notice}</p>}
        {hint && <p className="small">{hint}</p>}
      </div>
    </div>
  )
}
