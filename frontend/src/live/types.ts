// The only seam between the UI and the real-time media transport (implemented over WebSocket in
// ./hostLive.ts and ./listenerLive.ts; the protocol is documented in the README).
//
// The UI knows nothing about the transport: swap the implementations in ./index.ts for LiveKit or
// anything else and the screens don't change.

import type { MicState } from './mic'

export type LiveStatus =
  | 'unavailable' // the browser can't do it (no mic access, no WebSocket); see `error` where present
  | 'connecting'
  | 'live'
  | 'reconnecting' // connection dropped, retrying
  | 'ended' // the session is over

export interface Store<S> {
  getState(): S
  /** React useSyncExternalStore-compatible. */
  subscribe(listener: () => void): () => void
}

/** The host's mic goes out; captions for the control room come back. */
export interface HostLiveState {
  status: LiveStatus
  original: string
  translated: Record<string, string> // by target language code
  /** Why the mic isn't streaming, when it isn't. */
  error: string | null
  /** The browser won't start audio capture until the host taps (for example after a page refresh). */
  needsTap: boolean
  /** Which input is capturing, the available inputs, and notices about switching. */
  mic: MicState
}

export interface HostLive extends Store<HostLiveState> {
  /** Start publishing the mic for this session. */
  connect(sessionId: string): void
  /** Called from a user tap when needsTap is true. */
  resume(): void
  /** Switch input while live ('' = system default). The stream and connection carry on without a gap. */
  selectMic(choice: string): void
  /** Input loudness for the level meter (~10 Hz). Separate from the state so only the meter re-renders. */
  readonly micLevel: Store<{ level: number }>
  disconnect(): void
}

/** One dubbed audio track plays at a time; captions arrive in both languages. */
export interface ListenerLiveState {
  status: LiveStatus
  speaker: { name: string; speaking: boolean }
  original: string
  translated: string
  /** The browser refused to start audio without a tap; show a "tap to resume" prompt. */
  audioBlocked: boolean
  /** This language's translation is interrupted on the server (it is being restarted). */
  trackDown: boolean
}

export interface ListenerLive extends Store<ListenerLiveState> {
  connect(code: string, lang: string): void
  setLanguage(lang: string): void
  setVolume(volume: number): void // 0..1
  setMuted(muted: boolean): void
  /** Called from a user tap when audioBlocked is true. */
  resumeAudio(): void
  disconnect(): void
}
