// Test doubles. The fake engine is a test-only stand-in for Gemini, not a runtime mode.
import type { CloseReason, DubbingEngine, EngineStream, OpenOptions, Transcript } from '../src/engine/types.js'
import type { Conn } from '../src/session/track.js'

export class FakeStream implements EngineStream {
  pushed: Buffer[] = []
  /** What diagnostics() reports as received from the engine (defaults to just the setup message). */
  received: Record<string, unknown> = { messages: 1, audioChunks: 0 }
  closed = false
  handle: string | undefined
  private audioCb: (b: Buffer) => void = () => {}
  private transcriptCb: (t: Transcript) => void = () => {}
  private closeCb: (r: CloseReason) => void = () => {}

  constructor(readonly opts: OpenOptions) {}

  pushAudio(b: Buffer) {
    this.pushed.push(b)
  }
  onAudio(cb: (b: Buffer) => void) {
    this.audioCb = cb
  }
  onTranscript(cb: (t: Transcript) => void) {
    this.transcriptCb = cb
  }
  onClose(cb: (r: CloseReason) => void) {
    this.closeCb = cb
  }
  resumeHandle() {
    return this.handle
  }
  diagnostics() {
    return { received: this.received, sent: { chunks: this.pushed.length } }
  }
  close() {
    this.closed = true
  }

  emitAudio(b: Buffer) {
    this.audioCb(b)
  }
  emitTranscript(t: Transcript) {
    this.transcriptCb(t)
  }
  emitClose(r: CloseReason) {
    this.closeCb(r)
  }
}

export class FakeEngine implements DubbingEngine {
  streams: FakeStream[] = []
  /** Reject the next N open() calls. */
  failOpens = 0

  async open(opts: OpenOptions): Promise<EngineStream> {
    if (this.failOpens > 0) {
      this.failOpens--
      throw new Error('open failed')
    }
    const s = new FakeStream(opts)
    this.streams.push(s)
    return s
  }

  forLang(lang: string): FakeStream[] {
    return this.streams.filter((s) => s.opts.targetLang === lang)
  }
  latest(lang: string): FakeStream {
    const all = this.forLang(lang)
    return all[all.length - 1]!
  }
}

export class FakeConn implements Conn {
  binary: Buffer[] = []
  json: any[] = []
  buffered = 0
  closedWith: { code?: number; reason?: string } | null = null

  sendBinary(b: Buffer) {
    this.binary.push(b)
  }
  sendJson(o: unknown) {
    this.json.push(o)
  }
  bufferedAmount() {
    return this.buffered
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason }
  }

  last(type: string) {
    return [...this.json].reverse().find((m) => m.type === type)
  }
}

/** 100 ms of loud PCM16 16 kHz audio (a square-ish wave well above the speech threshold). */
export function loudChunk(): Buffer {
  const b = Buffer.alloc(3200)
  for (let i = 0; i < 1600; i++) b.writeInt16LE(i % 2 ? 9000 : -9000, i * 2)
  return b
}

export const silentChunk = (): Buffer => Buffer.alloc(3200)

/** A logger that records every call, for asserting on diagnostics. */
export function captureLog() {
  const calls: { level: 'debug' | 'info' | 'warn'; o: any; msg: string }[] = []
  const log = {
    debug: (o: object, msg: string) => calls.push({ level: 'debug', o, msg }),
    info: (o: object, msg: string) => calls.push({ level: 'info', o, msg }),
    warn: (o: object, msg: string) => calls.push({ level: 'warn', o, msg }),
  }
  return { log, calls, find: (msg: string) => calls.filter((c) => c.msg === msg) }
}
