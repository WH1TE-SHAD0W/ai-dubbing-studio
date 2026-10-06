import type { TrackState } from '../api/types'

const LABEL: Record<TrackState, { icon: string; text: string }> = {
  live: { icon: '●', text: 'Live' },
  starting: { icon: '◐', text: 'Starting' },
  error: { icon: '▲', text: 'Error' },
  degraded: { icon: '▲', text: 'Degraded' },
}

/** State is always text plus an icon, never colour alone. */
export function TrackStateChip({ state }: { state: TrackState }) {
  const { icon, text } = LABEL[state]
  return (
    <span className={`state state--${state}`}>
      <span aria-hidden="true">{icon}</span>
      {text}
    </span>
  )
}
