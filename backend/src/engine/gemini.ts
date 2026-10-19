import { GoogleGenAI, Modality, type LiveConnectParameters, type LiveServerMessage, type Session } from '@google/genai'
import { noopLog, type CloseReason, type DubbingEngine, type EngineStream, type Log, type OpenOptions, type Transcript } from './types.js'

const INPUT_MIME = 'audio/pcm;rate=16000'
/** The SDK's connect() never settles for some failures (an invalid key, for one), so we bound it. */
export const CONNECT_TIMEOUT_MS = 15_000
/** Wait this long for the server's setupComplete before sending audio anyway. */
const SETUP_GRACE_MS = 1500
/** At debug level, log the first few audio replies and then every Nth, so a busy stream stays readable. */
const AUDIO_LOG_FIRST = 3
const AUDIO_LOG_EVERY = 100

/** The only part of the SDK client we use, so tests can supply a fake. */
export interface LiveClient {
  live: { connect(params: LiveConnectParameters): Promise<Session> }
}

/**
 * One Gemini Live Translate session per target language.
 *
 * Live Translate is a continuous audio stream: there are no turns to wait for and text input is
 * not supported, so audio goes in through sendRealtimeInput() and translated 24 kHz PCM comes
 * out of serverContent.modelTurn as it is produced.
 */
export class GeminiEngine implements DubbingEngine {
  private readonly log: Log

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    log: Partial<Log> = {},
    private readonly client: LiveClient = new GoogleGenAI({ apiKey }),
    private readonly connectTimeoutMs = CONNECT_TIMEOUT_MS,
  ) {
    // Call through `log` so a real logger keeps its `this`.
    this.log = {
      debug: (o, m) => (log.debug ?? noopLog.debug).call(log, o, m),
      info: (o, m) => (log.info ?? noopLog.info).call(log, o, m),
      warn: (o, m) => (log.warn ?? noopLog.warn).call(log, o, m),
    }
  }

  /** Error text is safe to log and show: the key rides in the connection URL, so never let it through. */
  private clean(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join('***') : text
  }

  async open(opts: OpenOptions): Promise<EngineStream> {
    const stream = new GeminiStream(opts.targetLang, this.log, (t) => this.clean(t))
    const t0 = Date.now()
    this.log.info(
      { lang: opts.targetLang, model: this.model, resuming: !!opts.resumeHandle },
      'gemini connecting',
    )

    // connect() can fail without ever rejecting, so race it against early failure and a timeout.
    let timer: NodeJS.Timeout | undefined
    const failed = new Promise<never>((_, reject) => {
      stream.rejectOpen = reject
      timer = setTimeout(() => reject(new Error('Timed out connecting to Gemini')), this.connectTimeoutMs)
    })

    try {
      const session = await Promise.race([
        this.client.live.connect({
          model: this.model,
          config: {
            responseModalities: [Modality.AUDIO],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            translationConfig: { targetLanguageCode: opts.targetLang, echoTargetLanguage: false },
            // Without compression an audio-only session is capped at ~15 minutes.
            contextWindowCompression: { slidingWindow: {} },
            sessionResumption: opts.resumeHandle ? { handle: opts.resumeHandle } : {},
          },
          callbacks: {
            onopen: () => {},
            onmessage: (m: LiveServerMessage) => stream.handle(m),
            onerror: (e: ErrorEvent) => stream.fail(e.message),
            onclose: (e: CloseEvent) => stream.closedByServer(e.code, e.reason),
          },
        }),
        failed,
      ])
      stream.attach(session, Date.now() - t0)
      this.log.info({ lang: opts.targetLang, ms: Date.now() - t0 }, 'gemini connected (server accepted the setup)')
      return stream
    } catch (err) {
      stream.close()
      throw new Error(this.clean(err instanceof Error ? err.message : String(err)))
    } finally {
      clearTimeout(timer)
      stream.rejectOpen = undefined
    }
  }
}

/** Short names for what a server message carries, e.g. ['modelTurn.audio/pcm', 'serverContent.outputTranscription']. */
export function messageKinds(m: LiveServerMessage): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(m)) if (value != null && key !== 'serverContent') out.push(key)
  const sc = m.serverContent
  if (sc) {
    for (const [key, value] of Object.entries(sc)) {
      if (value == null || value === false) continue
      if (key === 'modelTurn') {
        for (const p of sc.modelTurn?.parts ?? []) {
          out.push(
            p.inlineData
              ? `modelTurn.${(p.inlineData.mimeType ?? 'inline').split(';')[0]}`
              : p.text !== undefined
                ? 'modelTurn.text'
                : 'modelTurn.other',
          )
        }
      } else {
        out.push(`serverContent.${key}`)
      }
    }
  }
  return out.length ? out : ['empty']
}

export class GeminiStream implements EngineStream {
  /** Set while connect() is still pending, so an early error or close can fail open() instead of vanishing. */
  rejectOpen: ((e: Error) => void) | undefined

  private session: Session | undefined
  private audioCb: (pcm: Buffer) => void = () => {}
  private transcriptCb: (t: Transcript) => void = () => {}
  private closeCb: (reason: CloseReason) => void = () => {}
  private resumption: string | undefined
  private done = false
  private goAwayReported = false
  private ready = false
  private openedAt = Date.now()

  // ---- diagnostics (counts and timings only; never content) ----
  private connectMs = 0
  private setupAt: number | null = null
  private sent = { chunks: 0, bytes: 0, held: 0, errors: 0, firstAt: 0, lastAt: 0 }
  private recv = {
    messages: 0,
    audioChunks: 0,
    audioBytes: 0,
    sourceFragments: 0,
    sourceChars: 0,
    targetFragments: 0,
    targetChars: 0,
    firstAudioAt: 0,
    firstTranscriptAt: 0,
    lastAt: 0,
  }
  private kinds: Record<string, number> = {}
  private usage: { prompt?: number; total?: number } | undefined
  private goAway: string | undefined

  constructor(
    private readonly lang: string,
    private readonly log: Log,
    private readonly clean: (text: string) => string = (t) => t,
  ) {}

  attach(session: Session, connectMs = 0): void {
    this.session = session
    this.openedAt = Date.now()
    this.connectMs = connectMs
  }

  pushAudio(pcm16k: Buffer): void {
    if (this.done || !this.session) return
    // Hold audio until the server accepted the setup, but never for long: if it doesn't announce it, send anyway.
    if (!this.ready && Date.now() - this.openedAt < SETUP_GRACE_MS) {
      this.sent.held++
      return
    }
    try {
      this.session.sendRealtimeInput({ audio: { data: pcm16k.toString('base64'), mimeType: INPUT_MIME } })
      const now = Date.now()
      if (this.sent.chunks === 0) {
        this.sent.firstAt = now
        this.log.info({ lang: this.lang, bytes: pcm16k.length }, 'gemini: first audio chunk sent')
      }
      this.sent.chunks++
      this.sent.bytes += pcm16k.length
      this.sent.lastAt = now
    } catch (err) {
      // The socket is closing; onclose will report it.
      if (this.sent.errors++ === 0) {
        this.log.warn({ lang: this.lang, message: this.clean(err instanceof Error ? err.message : String(err)) }, 'gemini: sending audio failed')
      }
    }
  }

  onAudio(cb: (pcm: Buffer) => void): void {
    this.audioCb = cb
  }
  onTranscript(cb: (t: Transcript) => void): void {
    this.transcriptCb = cb
  }
  onClose(cb: (reason: CloseReason) => void): void {
    this.closeCb = cb
  }
  resumeHandle(): string | undefined {
    return this.resumption
  }

  diagnostics(): Record<string, unknown> {
    const now = Date.now()
    const ago = (t: number) => (t ? now - t : null)
    return {
      lang: this.lang,
      connectMs: this.connectMs,
      setupCompleteAfterMs: this.setupAt,
      sent: {
        chunks: this.sent.chunks,
        kb: Math.round(this.sent.bytes / 1024),
        heldBeforeSetup: this.sent.held,
        errors: this.sent.errors,
        lastAgoMs: ago(this.sent.lastAt),
      },
      received: {
        messages: this.recv.messages,
        audioChunks: this.recv.audioChunks,
        audioKb: Math.round(this.recv.audioBytes / 1024),
        sourceFragments: this.recv.sourceFragments,
        sourceChars: this.recv.sourceChars,
        targetFragments: this.recv.targetFragments,
        targetChars: this.recv.targetChars,
        lastAgoMs: ago(this.recv.lastAt),
        firstAudioAfterFirstSendMs:
          this.recv.firstAudioAt && this.sent.firstAt ? this.recv.firstAudioAt - this.sent.firstAt : null,
      },
      messageKinds: this.kinds,
      usage: this.usage ?? null,
      goAway: this.goAway ?? null,
      canResume: !!this.resumption,
      closed: this.done,
    }
  }

  close(): void {
    if (this.done) return
    this.done = true // no onClose after an intentional close
    try {
      this.session?.close()
    } catch {
      /* already closed */
    }
  }

  /** Entry point for every server message. */
  handle(m: LiveServerMessage): void {
    if (this.done) return
    const now = Date.now()
    this.recv.messages++
    this.recv.lastAt = now

    const kinds = messageKinds(m)
    for (const k of kinds) this.kinds[k] = (this.kinds[k] ?? 0) + 1

    if (m.setupComplete) {
      this.ready = true
      this.setupAt = now - this.openedAt
      this.log.debug({ lang: this.lang }, 'gemini: setupComplete')
    }

    const parts = m.serverContent?.modelTurn?.parts
    if (parts) {
      for (const p of parts) {
        if (!p.inlineData?.data) continue
        const audio = Buffer.from(p.inlineData.data, 'base64')
        this.recv.audioChunks++
        this.recv.audioBytes += audio.length
        if (!this.recv.firstAudioAt) {
          this.recv.firstAudioAt = now
          this.log.info(
            {
              lang: this.lang,
              bytes: audio.length,
              mime: p.inlineData.mimeType,
              afterFirstSendMs: this.sent.firstAt ? now - this.sent.firstAt : null,
            },
            'gemini: first translated audio received',
          )
        }
        if (this.recv.audioChunks <= AUDIO_LOG_FIRST || this.recv.audioChunks % AUDIO_LOG_EVERY === 0) {
          this.log.debug(
            { lang: this.lang, n: this.recv.audioChunks, bytes: audio.length, mime: p.inlineData.mimeType },
            'gemini: audio chunk',
          )
        }
        this.audioCb(audio)
      }
    }

    const input = m.serverContent?.inputTranscription
    if (input?.text) {
      this.recv.sourceFragments++
      this.recv.sourceChars += input.text.length
      this.noteTranscript('source', input.text.length, input.finished, input.languageCode)
      this.transcriptCb({ kind: 'source', text: input.text, finished: input.finished })
    }
    const output = m.serverContent?.outputTranscription
    if (output?.text) {
      this.recv.targetFragments++
      this.recv.targetChars += output.text.length
      this.noteTranscript('target', output.text.length, output.finished, output.languageCode)
      this.transcriptCb({ kind: 'target', text: output.text, finished: output.finished })
    }

    if (m.usageMetadata) {
      this.usage = { prompt: m.usageMetadata.promptTokenCount, total: m.usageMetadata.totalTokenCount }
    }

    const update = m.sessionResumptionUpdate
    if (update?.newHandle && update.resumable !== false) this.resumption = update.newHandle

    // Everything that is not plain audio is rare and informative, so show its shape at debug level.
    const interesting = kinds.filter((k) => !k.startsWith('modelTurn.audio') && !k.includes('Transcription'))
    if (interesting.length) {
      this.log.debug(
        {
          lang: this.lang,
          kinds: interesting,
          ...(m.usageMetadata && { usage: this.usage }),
          ...(update && { resumable: update.resumable, hasHandle: !!update.newHandle }),
          ...(m.goAway && { timeLeft: m.goAway.timeLeft }),
        },
        'gemini: message',
      )
    }

    // A goaway is only a warning: the stream keeps working until the replacement is ready.
    if (m.goAway && !this.goAwayReported) {
      this.goAwayReported = true
      this.goAway = m.goAway.timeLeft
      this.log.info({ lang: this.lang, timeLeft: m.goAway.timeLeft }, 'gemini: goAway, opening a replacement stream')
      this.closeCb('goaway')
    }
  }

  /** Lengths and flags only: transcript text is never logged. */
  private noteTranscript(kind: 'source' | 'target', chars: number, finished: boolean | undefined, languageCode: string | undefined) {
    if (!this.recv.firstTranscriptAt) {
      this.recv.firstTranscriptAt = Date.now()
      this.log.info({ lang: this.lang, kind, languageCode }, 'gemini: first transcript received')
    }
    this.log.debug({ lang: this.lang, kind, chars, finished: !!finished, languageCode }, 'gemini: transcript')
  }

  fail(message: string | undefined): void {
    const text = this.clean(message ?? 'unknown error')
    this.log.warn({ lang: this.lang, message: text }, 'gemini stream error')
    if (this.rejectOpen) return this.rejectOpen(new Error(text))
    this.end('error')
  }

  closedByServer(code?: number, reason?: string): void {
    const text = this.clean(`closed by server (code ${code ?? '?'}${reason ? `: ${reason}` : ''})`)
    // We closed it ourselves (session over, stream replaced): the socket's close event is just the echo of that.
    if (this.done) return this.log.debug({ lang: this.lang, code, ...this.summary() }, 'gemini stream closed (by us)')
    this.log.warn({ lang: this.lang, message: text, ...this.summary() }, 'gemini stream closed')
    if (this.rejectOpen) return this.rejectOpen(new Error(text))
    this.end('closed')
  }

  /** Compact context to attach to a close/failure log line. */
  private summary() {
    return { sentChunks: this.sent.chunks, receivedMessages: this.recv.messages, receivedAudioChunks: this.recv.audioChunks }
  }

  private end(reason: CloseReason): void {
    if (this.done) return
    this.done = true
    this.closeCb(reason)
  }
}
