// The backend contract this frontend expects (HLD section 6, subset). All paths are under /api;
// nginx (and the Vite dev proxy) strip that prefix before forwarding.

export type TrackState = 'starting' | 'live' | 'error' | 'degraded'

export interface TrackStat {
  lang: string
  state: TrackState
  listeners: number
}

/** One SSE message from GET /sessions/:id/stats. */
export interface SessionStats {
  listeners: number
  latencyMs: number | null
  tracks: TrackStat[]
}

export interface CreateSessionRequest {
  title: string
  sourceLang: string
  targetLangs: string[]
  consent: { speaker: true; aiNotice: true; textVersion: string }
}

export interface CreatedSession {
  id: string
  joinCode: string
}

/** POST /sessions/:id/start. Must be idempotent so a refresh re-enters the studio. */
export interface StartedSession {
  id: string
  title: string
  joinCode: string
  sourceLang: string
  startedAt: number // epoch ms
}

/** GET /join/:code */
export interface JoinInfo {
  title: string
  speakerName: string
  sourceLang: string
  languages: string[]
}

/** Bump when the consent wording shown on the create-session screen changes. */
export const CONSENT_TEXT_VERSION = '2026-10-v1'
