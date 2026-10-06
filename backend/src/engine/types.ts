// The engine adapter from the HLD. The session code only knows these interfaces, so Gemini can be
// swapped for another engine (or a test double) without touching the relay.

/** Structured logger (pino-compatible). Never pass audio, transcript text or keys through it. */
export interface Log {
  debug(o: object, msg: string): void
  info(o: object, msg: string): void
  warn(o: object, msg: string): void
}

export const noopLog: Log = { debug() {}, info() {}, warn() {} }

export interface OpenOptions {
  targetLang: string
  /** Continue a previous stream where the engine supports it. */
  resumeHandle?: string
}

export interface Transcript {
  kind: 'source' | 'target'
  text: string
  /** The engine marked this segment complete. */
  finished?: boolean
}

export type CloseReason = 'goaway' | 'error' | 'closed'

export interface EngineStream {
  /** PCM16 LE mono 16 kHz, ~100 ms per call. */
  pushAudio(pcm16k: Buffer): void
  /** PCM16 LE mono 24 kHz translated audio. */
  onAudio(cb: (pcm24k: Buffer) => void): void
  onTranscript(cb: (t: Transcript) => void): void
  /**
   * 'goaway' is a warning: the stream still works for a short while, so the caller should open a
   * replacement before closing this one. 'error' / 'closed' mean it is already gone.
   * Never fires after close() is called.
   */
  onClose(cb: (reason: CloseReason) => void): void
  /** Opaque handle to resume this stream on a new connection, if the engine offers one. */
  resumeHandle(): string | undefined
  /** Counters for debugging: what was sent, what came back, and when. Safe to log (no content). */
  diagnostics?(): Record<string, unknown>
  close(): void
}

export interface DubbingEngine {
  open(opts: OpenOptions): Promise<EngineStream>
}
