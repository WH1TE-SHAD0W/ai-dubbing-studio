import { Chunker, rms } from '../audio.js'
import { noopLog, type DubbingEngine, type Log, type Transcript } from '../engine/types.js'
import { RollingCaption } from './caption.js'
import { Track, type Conn, type TrackOptions, type TrackState } from './track.js'

export interface TrackStat {
  lang: string
  state: TrackState
  listeners: number
}

export interface SessionStats {
  listeners: number
  latencyMs: number | null
  tracks: TrackStat[]
}

export interface SessionInit {
  id: string
  joinCode: string
  title: string
  sourceLang: string
  targetLangs: string[]
  hostName: string
}

export interface SessionDeps {
  engine: DubbingEngine
  now?: () => number
  track?: TrackOptions
  /** Called once when the session ends, for any reason. */
  onEnded?: (s: Session, reason: string) => void
  log?: Partial<Log>
}

export type AddListenerResult = 'ok' | 'not-live' | 'no-lang'

// Tuning. Speech detection is deliberately crude: it only drives the "speaking" indicator and the
// rough latency estimate, never what is sent to the engine (all host audio is always forwarded).
const LOUD_RMS = 0.012
const SILENCE_HOLD_MS = 700
const TICK_MS = 200
const REPORT_EVERY_MS = 5000
/** Host connected but no audio frames for this long, or frames that are all silent for this long. */
const HOST_NO_AUDIO_MS = 5000
const HOST_SILENT_MS = 10_000
const HOST_WARN_REPEAT_MS = 15_000
/** A listener socket this far behind (~5 s of 24 kHz PCM16) gets frames dropped instead of buffered. */
const MAX_LISTENER_BACKLOG = 256 * 1024

export class Session {
  readonly id: string
  readonly joinCode: string
  readonly title: string
  readonly sourceLang: string
  readonly targetLangs: string[]
  readonly hostName: string

  readonly createdAt: number
  status: 'draft' | 'live' | 'ended' = 'draft'
  startedAt: number | null = null
  /** When the host last left (or the session started with no host yet). */
  hostGoneAt: number | null = null

  private readonly tracks = new Map<string, Track>()
  private readonly listenerLang = new Map<Conn, string>()
  private host: Conn | null = null
  private readonly chunker = new Chunker()
  private readonly source = new RollingCaption()
  private speaking = false
  private lastLoudAt = 0
  private timer: NodeJS.Timeout | undefined
  private readonly now: () => number
  private readonly log: Log

  // ---- diagnostics ----
  private readonly hostStats = { frames: 0, bytes: 0, loudChunks: 0, chunks: 0, maxRms: 0, lastRms: 0, firstAt: 0, lastFrameAt: 0, lastLoudAt: 0, connectedAt: 0 }
  private readonly relayStats = { audioChunksToListeners: 0, droppedForSlowListeners: 0, captionsSent: 0 }
  private lastReportAt = 0
  private lastHostWarnAt = 0

  constructor(init: SessionInit, private readonly deps: SessionDeps) {
    this.id = init.id
    this.joinCode = init.joinCode
    this.title = init.title
    this.sourceLang = init.sourceLang
    this.targetLangs = init.targetLangs
    this.hostName = init.hostName
    this.now = deps.now ?? Date.now
    this.createdAt = this.now()
    const l = deps.log ?? {}
    // Call through `l` so a real logger keeps its `this`.
    this.log = {
      debug: (o, m) => (l.debug ?? noopLog.debug).call(l, { session: this.id, ...o }, m),
      info: (o, m) => (l.info ?? noopLog.info).call(l, { session: this.id, ...o }, m),
      warn: (o, m) => (l.warn ?? noopLog.warn).call(l, { session: this.id, ...o }, m),
    }
  }

  /** Idempotent: starting a live session is a no-op, so the studio can call it on every load. */
  start(): void {
    if (this.status !== 'draft') return
    this.status = 'live'
    this.startedAt = this.now()
    this.hostGoneAt = this.startedAt
    this.log.info({ title: this.title, source: this.sourceLang, targets: this.targetLangs }, 'session started')

    for (const lang of this.targetLangs) {
      const track = new Track(
        lang,
        this.deps.engine,
        {
          audio: (t, buf) => this.sendAudio(t, buf),
          transcript: (t, tr) => this.onTranscript(t, tr),
          state: (t) => this.onTrackState(t),
          failure: (t, message) => this.log.warn({ lang: t.lang, message }, 'engine failure'),
          log: this.log,
        },
        { now: this.now, ...this.deps.track },
      )
      this.tracks.set(lang, track)
      track.start()
    }
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  end(reason = 'ended'): void {
    if (this.status === 'ended') return
    this.log.info({ reason, ...this.debugSnapshot() }, 'session ended')
    this.status = 'ended'
    clearInterval(this.timer)
    for (const track of this.tracks.values()) {
      track.close()
      for (const conn of track.listeners) {
        conn.sendJson({ type: 'ended' })
        conn.close(1000, 'ended')
      }
      track.listeners.clear()
    }
    this.listenerLang.clear()
    this.host?.sendJson({ type: 'status', ended: true })
    this.host?.close(1000, 'ended')
    this.host = null
    this.deps.onEnded?.(this, reason)
  }

  // ---- host ----

  setHost(conn: Conn): void {
    if (this.host && this.host !== conn) this.host.close(4000, 'replaced')
    this.host = conn
    this.hostGoneAt = null
    this.hostStats.connectedAt = this.now()
    this.log.info({}, 'host connected')
    this.sendHostCaption()
  }

  hostLeft(conn: Conn): void {
    if (this.host !== conn) return // already replaced
    this.host = null
    this.hostGoneAt = this.now()
    this.log.info({ framesReceived: this.hostStats.frames }, 'host disconnected')
  }

  get hasHost(): boolean {
    return this.host !== null
  }

  /** Mic audio from the host: PCM16 LE mono 16 kHz, any frame size. */
  pushHostAudio(frame: Buffer): void {
    if (this.status !== 'live') return
    const t = this.now()
    const h = this.hostStats
    if (!h.firstAt) {
      h.firstAt = t
      this.log.info({ bytes: frame.length }, 'host audio: first frame received')
    }
    h.frames++
    h.bytes += frame.length
    h.lastFrameAt = t
    for (const chunk of this.chunker.push(frame)) {
      const level = rms(chunk)
      const loud = level > LOUD_RMS
      h.chunks++
      h.lastRms = level
      h.maxRms = Math.max(h.maxRms, level)
      if (loud) {
        h.loudChunks++
        h.lastLoudAt = t
        this.lastLoudAt = t
        this.setSpeaking(true)
      }
      for (const track of this.tracks.values()) track.pushAudio(chunk, loud)
    }
  }

  // ---- listeners ----

  addListener(lang: string, conn: Conn): AddListenerResult {
    if (this.status !== 'live') return 'not-live'
    const track = this.tracks.get(lang)
    if (!track) return 'no-lang'
    track.listeners.add(conn)
    this.listenerLang.set(conn, lang)
    this.log.debug({ lang, listeners: this.listenerLang.size, trackState: track.state }, 'listener joined')
    conn.sendJson({ type: 'speaker', speaking: this.speaking })
    conn.sendJson({ type: 'status', trackDown: isDown(track) })
    this.sendCaption(track, conn)
    return 'ok'
  }

  /** Switch language: just a different fan-out set, no new engine work. */
  moveListener(conn: Conn, lang: string): boolean {
    const target = this.tracks.get(lang)
    const from = this.listenerLang.get(conn)
    if (!target || from === undefined) return false
    if (from === lang) return true
    this.tracks.get(from)?.listeners.delete(conn)
    target.listeners.add(conn)
    this.listenerLang.set(conn, lang)
    conn.sendJson({ type: 'status', trackDown: isDown(target) })
    this.sendCaption(target, conn)
    return true
  }

  removeListener(conn: Conn): void {
    const lang = this.listenerLang.get(conn)
    if (lang === undefined) return
    this.tracks.get(lang)?.listeners.delete(conn)
    this.listenerLang.delete(conn)
    this.log.debug({ lang, listeners: this.listenerLang.size }, 'listener left')
  }

  // ---- stats / control ----

  stats(): SessionStats {
    const tracks = [...this.tracks.values()]
    const latencies = tracks.flatMap((t) => (t.latencyMs === null ? [] : [t.latencyMs]))
    return {
      listeners: this.listenerLang.size,
      // Worst track: the studio should show how far behind the slowest language is.
      latencyMs: latencies.length ? Math.round(Math.max(...latencies)) : null,
      tracks: tracks.map((t) => ({ lang: t.lang, state: t.state, listeners: t.listeners.size })),
    }
  }

  retryTrack(lang: string): boolean {
    return this.tracks.get(lang)?.retry() ?? false
  }

  // ---- internals ----

  private tick(): void {
    const t = this.now()
    if (this.speaking && t - this.lastLoudAt > SILENCE_HOLD_MS) {
      this.setSpeaking(false)
      for (const track of this.tracks.values()) track.markEndOfSpeech(this.lastLoudAt)
    }
    for (const track of this.tracks.values()) track.tick()
    this.diagnose(t)
  }

  /** Periodic debug report, and warnings for the host-side causes of "nothing happens". */
  private diagnose(t: number): void {
    const h = this.hostStats
    if (this.host && t - this.lastHostWarnAt >= HOST_WARN_REPEAT_MS) {
      const sinceConnect = t - h.connectedAt
      if (sinceConnect > HOST_NO_AUDIO_MS && (!h.lastFrameAt || t - h.lastFrameAt > HOST_NO_AUDIO_MS)) {
        this.lastHostWarnAt = t
        this.log.warn(
          {
            msSinceHostConnected: sinceConnect,
            framesEver: h.frames,
            hint: 'the mic is not capturing, or the browser is waiting for a tap to start audio',
          },
          'host is connected but no audio frames are arriving',
        )
      } else if (h.chunks > 0 && sinceConnect > HOST_SILENT_MS && (!h.lastLoudAt || t - h.lastLoudAt > HOST_SILENT_MS)) {
        this.lastHostWarnAt = t
        this.log.warn(
          {
            maxRms: +h.maxRms.toFixed(4),
            speechThreshold: LOUD_RMS,
            chunks: h.chunks,
            hint: 'wrong input device, muted mic, or the level is too low',
          },
          'host audio is arriving but it is silent',
        )
      }
    }
    if (t - this.lastReportAt >= REPORT_EVERY_MS) {
      this.lastReportAt = t
      this.log.debug(this.debugSnapshot(), 'session report')
    }
  }

  /** Counts and timings for the debug endpoint and log reports. Never contains audio or text. */
  debugSnapshot() {
    const h = this.hostStats
    const t = this.now()
    return {
      status: this.status,
      uptimeS: this.startedAt ? Math.round((t - this.startedAt) / 1000) : 0,
      host: {
        connected: this.host !== null,
        frames: h.frames,
        kb: Math.round(h.bytes / 1024),
        chunks100ms: h.chunks,
        loudChunks: h.loudChunks,
        lastRms: +h.lastRms.toFixed(4),
        maxRms: +h.maxRms.toFixed(4),
        speechThreshold: LOUD_RMS,
        lastFrameAgoMs: h.lastFrameAt ? t - h.lastFrameAt : null,
        speaking: this.speaking,
      },
      relay: { ...this.relayStats },
      tracks: [...this.tracks.values()].map((track) => track.diagnostics()),
    }
  }

  private setSpeaking(value: boolean): void {
    if (this.speaking === value) return
    this.speaking = value
    for (const conn of this.listenerLang.keys()) conn.sendJson({ type: 'speaker', speaking: value })
  }

  private sendAudio(track: Track, pcm24k: Buffer): void {
    for (const conn of track.listeners) {
      if (conn.bufferedAmount() > MAX_LISTENER_BACKLOG) {
        this.relayStats.droppedForSlowListeners++ // slow listener: drop, don't buffer
        continue
      }
      conn.sendBinary(pcm24k)
      this.relayStats.audioChunksToListeners++
    }
  }

  /** The first live track supplies the source-language text; every track transcribes the same input. */
  private primary(): Track | undefined {
    return [...this.tracks.values()].find((t) => t.state === 'live')
  }

  private onTranscript(track: Track, tr: Transcript): void {
    const at = this.now()
    if (tr.kind === 'target') {
      track.caption.add(tr.text, tr.finished, at)
      for (const conn of track.listeners) this.sendCaption(track, conn)
    } else if (track === this.primary()) {
      this.source.add(tr.text, tr.finished, at)
      for (const t of this.tracks.values()) for (const conn of t.listeners) this.sendCaption(t, conn)
    } else {
      return
    }
    this.sendHostCaption()
  }

  private sendCaption(track: Track, conn: Conn): void {
    const original = this.source.current
    const translated = track.caption.current
    if (original || translated) {
      conn.sendJson({ type: 'caption', original, translated })
      this.relayStats.captionsSent++
    }
  }

  private sendHostCaption(): void {
    if (!this.host) return
    const translated: Record<string, string> = {}
    for (const t of this.tracks.values()) translated[t.lang] = t.caption.current
    this.host.sendJson({ type: 'caption', original: this.source.current, translated })
  }

  private onTrackState(track: Track): void {
    for (const conn of track.listeners) conn.sendJson({ type: 'status', trackDown: isDown(track) })
  }
}

const isDown = (t: Track): boolean => t.state === 'error' || t.state === 'degraded'
