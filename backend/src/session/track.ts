import { rms } from '../audio.js'
import type { CloseReason, DubbingEngine, EngineStream, Log, Transcript } from '../engine/types.js'
import { RollingCaption } from './caption.js'

/** A connection to one browser (host or listener), independent of the WebSocket library. */
export interface Conn {
  sendBinary(data: Buffer): void
  sendJson(obj: unknown): void
  bufferedAmount(): number
  close(code?: number, reason?: string): void
}

export type TrackState = 'starting' | 'live' | 'error' | 'degraded'

export interface TrackHooks {
  audio(track: Track, pcm24k: Buffer): void
  transcript(track: Track, t: Transcript): void
  state(track: Track): void
  /** A stream failed to open or died; `message` is safe to log. */
  failure?(track: Track, message: string): void
  /** Structured diagnostics (state changes, watchdog). Counts and timings only, never content. */
  log?: Log
}

export interface TrackOptions {
  now?: () => number
  /** Delay before each reopen attempt; its length is the number of attempts before 'error'. */
  backoffMs?: number[]
}

/** A stream must stay up this long before earlier failures stop counting against it (so a stream that opens and dies at once can't loop forever). */
const STABLE_MS = 10_000
/** Loud host chunks (100 ms each) sent with no translated audio back before the watchdog warns: 8 s of speech. */
const WATCHDOG_LOUD_CHUNKS = 80
const WATCHDOG_REPEAT_MS = 15_000
const AUDIBLE_RMS = 0.004
const OUTPUT_QUIET_MS = 700
const EOS_TIMEOUT_MS = 8000
const EMA = 0.3

/**
 * One target language: one engine stream shared by every listener of that language.
 * Owns reconnecting, so a flaky stream degrades one language, not the whole session.
 */
export class Track {
  state: TrackState = 'starting'
  readonly listeners = new Set<Conn>()
  readonly caption = new RollingCaption()
  /** Smoothed estimate, or null before the first measurement. */
  latencyMs: number | null = null

  private stream: EngineStream | null = null
  private attempts = 0
  private everLive = false
  private connecting = false
  private closed = false
  private resume: string | undefined
  private timer: NodeJS.Timeout | undefined
  private lastOutAt = 0
  private adoptedAt = 0
  private lastWarnAt = 0
  private loudSinceOutput = 0
  private readonly counts = {
    sent: 0,
    sentLoud: 0,
    droppedNoStream: 0,
    outChunks: 0,
    outAudible: 0,
    outBytes: 0,
    outTranscripts: 0,
    reopens: 0,
  }
  private pendingEos: number | null = null
  private readonly now: () => number
  private readonly backoff: number[]

  constructor(
    readonly lang: string,
    private readonly engine: DubbingEngine,
    private readonly hooks: TrackHooks,
    opts: TrackOptions = {},
  ) {
    this.now = opts.now ?? Date.now
    this.backoff = opts.backoffMs ?? [500, 1500, 4000]
  }

  start(): void {
    void this.connect()
  }

  /** `loud` says the chunk looks like speech (not just room noise); it only feeds the watchdog. */
  pushAudio(chunk: Buffer, loud = false): void {
    if (!this.stream) {
      this.counts.droppedNoStream++
      return
    }
    this.counts.sent++
    if (loud) {
      this.counts.sentLoud++
      this.loudSinceOutput++
    }
    this.stream.pushAudio(chunk)
  }

  /** Manual retry for a track that gave up (the studio's "Retry" link). */
  retry(): boolean {
    if (this.closed || this.state === 'live' || this.state === 'starting') return false
    clearTimeout(this.timer)
    this.attempts = 0
    this.stream?.close()
    this.stream = null
    this.setState('starting')
    void this.connect()
    return true
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    this.stream?.close()
    this.stream = null
  }

  /** The host stopped talking at `at`. Used for the latency estimate. */
  markEndOfSpeech(at: number): void {
    this.pendingEos = at
  }

  /**
   * Approximate "end of speech to translated audio": from the host going quiet to the end of the
   * translated output burst that follows, smoothed. Only a rough lag indicator, to be calibrated in the PoC.
   */
  tick(): void {
    this.watchdog()
    if (this.pendingEos === null) return
    const t = this.now()
    if (this.lastOutAt >= this.pendingEos && t - this.lastOutAt > OUTPUT_QUIET_MS) {
      const sample = this.lastOutAt - this.pendingEos
      this.latencyMs = this.latencyMs === null ? sample : (1 - EMA) * this.latencyMs + EMA * sample
      this.pendingEos = null
    } else if (t - this.pendingEos > EOS_TIMEOUT_MS) {
      this.pendingEos = null
    }
  }

  /**
   * Gemini accepted the connection but stays quiet: the symptom behind "it connects but nothing
   * happens". Warn (rate-limited) with enough context to tell the usual causes apart.
   */
  private watchdog(): void {
    if (this.state !== 'live' || this.loudSinceOutput < WATCHDOG_LOUD_CHUNKS) return
    const t = this.now()
    if (t - this.lastWarnAt < WATCHDOG_REPEAT_MS) return
    this.lastWarnAt = t
    const d = this.stream?.diagnostics?.() as { received?: { messages?: number; audioChunks?: number; sourceFragments?: number; targetFragments?: number }; messageKinds?: Record<string, number> } | undefined
    const received = d?.received
    const nothingBack = (received?.messages ?? 0) <= 1 // at most the setupComplete
    this.hooks.log?.warn(
      {
        lang: this.lang,
        loudChunksSentWithoutTranslatedAudio: this.loudSinceOutput,
        speechSecondsWithoutOutput: Math.round(this.loudSinceOutput / 10),
        gemini: d,
        likelyCause: nothingBack
          ? 'Gemini sent nothing back: check the model name and key access, and that the spoken language differs from the target'
          : (received?.audioChunks ?? 0) === 0
            ? 'Gemini replies but without audio: see messageKinds for what it sends instead'
            : 'Gemini sent audio earlier but has stopped: possible stream stall',
      },
      'gemini is not responding to speech',
    )
  }

  diagnostics(): Record<string, unknown> {
    return {
      lang: this.lang,
      state: this.state,
      listeners: this.listeners.size,
      attempts: this.attempts,
      relay: {
        chunksSentToGemini: this.counts.sent,
        loudChunksSent: this.counts.sentLoud,
        droppedWhileNoStream: this.counts.droppedNoStream,
        audioChunksFromGemini: this.counts.outChunks,
        audibleAudioChunks: this.counts.outAudible,
        audioKbFromGemini: Math.round(this.counts.outBytes / 1024),
        transcriptFragmentsFromGemini: this.counts.outTranscripts,
        reopens: this.counts.reopens,
        lastAudibleOutputAgoMs: this.lastOutAt ? this.now() - this.lastOutAt : null,
      },
      gemini: this.stream?.diagnostics?.() ?? null,
    }
  }

  private async connect(): Promise<void> {
    if (this.closed || this.connecting) return
    this.connecting = true
    let next: EngineStream
    try {
      next = await this.engine.open({ targetLang: this.lang, resumeHandle: this.resume })
    } catch (err) {
      this.connecting = false
      this.hooks.failure?.(this, err instanceof Error ? err.message : String(err))
      this.failed()
      return
    }
    this.connecting = false
    if (this.closed) {
      next.close()
      return
    }
    this.adopt(next)
  }

  /** Make `next` the active stream (the previous one, if any, is retired). */
  private adopt(next: EngineStream): void {
    const previous = this.stream
    this.stream = next
    next.onAudio((buf) => {
      if (this.stream !== next) return
      // Only audible output counts as translation activity: an engine that streams silence between
      // phrases must not make the output burst look endless.
      this.counts.outChunks++
      this.counts.outBytes += buf.length
      if (rms(buf) > AUDIBLE_RMS) {
        this.lastOutAt = this.now()
        this.counts.outAudible++
        this.loudSinceOutput = 0
      }
      this.hooks.audio(this, buf)
    })
    next.onTranscript((t) => {
      if (this.stream !== next) return
      this.counts.outTranscripts++
      this.hooks.transcript(this, t)
    })
    next.onClose((reason) => this.streamClosed(next, reason))
    previous?.close()
    if (this.everLive) this.counts.reopens++
    this.adoptedAt = this.now()
    this.everLive = true
    this.setState('live')
  }

  private streamClosed(s: EngineStream, reason: CloseReason): void {
    if (this.closed || s !== this.stream) return
    this.resume = s.resumeHandle() ?? this.resume
    if (reason === 'goaway') {
      // Make-before-break: the old stream keeps working until the replacement is ready.
      void this.connect()
      return
    }
    this.hooks.failure?.(this, `stream ${reason}`)
    if (this.now() - this.adoptedAt >= STABLE_MS) this.attempts = 0 // it was healthy for a while: start the count over
    this.stream = null
    this.failed()
  }

  private failed(): void {
    if (this.closed) return
    if (this.attempts >= this.backoff.length) {
      this.setState('error')
      return
    }
    const delay = this.backoff[this.attempts++]
    this.setState(this.everLive ? 'degraded' : 'starting')
    this.timer = setTimeout(() => void this.connect(), delay)
    this.timer.unref?.()
  }

  private setState(state: TrackState): void {
    if (this.state === state) return
    const from = this.state
    this.state = state
    this.hooks.log?.info({ lang: this.lang, from, to: state, attempts: this.attempts }, 'track state changed')
    this.hooks.state(this)
  }
}
