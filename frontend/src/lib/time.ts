const pad = (n: number) => String(n).padStart(2, '0')

/** 2537000 -> 00:42:17 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

/** 30 -> 0:30 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${pad(s % 60)}`
}

export type LatencyLevel = 'good' | 'fair' | 'slow'

// Thresholds are placeholders; the real targets are fixed at PoC exit.
const GOOD_MS = 1500
const FAIR_MS = 3000
const BAR_FULL_MS = 4000

export function latencyLevel(ms: number): LatencyLevel {
  return ms <= GOOD_MS ? 'good' : ms <= FAIR_MS ? 'fair' : 'slow'
}

/** 0..1 fill for the latency bar. */
export function latencyFill(ms: number): number {
  return Math.min(1, Math.max(0, ms / BAR_FULL_MS))
}

/** 1400 -> 1.4 s */
export function formatLatency(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}
