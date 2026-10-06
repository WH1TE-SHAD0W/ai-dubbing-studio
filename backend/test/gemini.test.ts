import type { LiveConnectParameters, LiveServerMessage, Session } from '@google/genai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GeminiEngine, messageKinds, type LiveClient } from '../src/engine/gemini.js'
import type { Log } from '../src/engine/types.js'
import { captureLog } from './fakes.js'

const KEY = 'AIza-secret-key-123'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/** A fake SDK client whose connect() the test controls. */
function fakeClient() {
  const fakeSession = { sendRealtimeInput: vi.fn(), close: vi.fn() }
  let params!: LiveConnectParameters
  let settle: ((s: Session) => void) | undefined
  const client: LiveClient = {
    live: {
      connect: (p) => {
        params = p
        return new Promise<Session>((resolve) => {
          settle = resolve
        })
      },
    },
  }
  return {
    client,
    session: fakeSession,
    params: () => params,
    resolve: () => settle!(fakeSession as unknown as Session),
    message: (m: Partial<LiveServerMessage>) => params.callbacks!.onmessage!(m as LiveServerMessage),
    error: (message: string) => params.callbacks!.onerror!({ message } as ErrorEvent),
    close: (code: number, reason: string) => params.callbacks!.onclose!({ code, reason } as CloseEvent),
  }
}

const audioMsg = (bytes: number[]): Partial<LiveServerMessage> => ({
  serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.from(bytes).toString('base64'), mimeType: 'audio/pcm;rate=24000' } }] } },
})

async function openStream(opts: { resumeHandle?: string } = {}, log: Partial<Log> = { warn: () => {} }) {
  const f = fakeClient()
  const engine = new GeminiEngine(KEY, 'models/test', log, f.client, 5000)
  const pending = engine.open({ targetLang: 'sk', ...opts })
  await vi.advanceTimersByTimeAsync(0)
  f.resolve()
  const stream = await pending
  return { f, stream }
}

describe('GeminiEngine.open', () => {
  it('requests continuous audio translation into the target language', async () => {
    const { f } = await openStream()
    const cfg = f.params().config!
    expect(f.params().model).toBe('models/test')
    expect(cfg.responseModalities).toEqual(['AUDIO'])
    expect(cfg.translationConfig).toEqual({ targetLanguageCode: 'sk', echoTargetLanguage: false })
    expect(cfg.inputAudioTranscription).toEqual({})
    expect(cfg.outputAudioTranscription).toEqual({})
    expect(cfg.contextWindowCompression).toEqual({ slidingWindow: {} })
    expect(cfg.sessionResumption).toEqual({})
  })

  it('passes the resume handle when resuming', async () => {
    const { f } = await openStream({ resumeHandle: 'H-1' })
    expect(f.params().config!.sessionResumption).toEqual({ handle: 'H-1' })
  })

  it('rejects instead of hanging when connect never settles (the SDK does this for an invalid key)', async () => {
    const f = fakeClient()
    const engine = new GeminiEngine(KEY, 'm', undefined, f.client, 5000)
    const pending = engine.open({ targetLang: 'sk' })
    const assertion = expect(pending).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(5001)
    await assertion
  })

  it('rejects when the server closes the connection during setup, with the reason', async () => {
    const f = fakeClient()
    const engine = new GeminiEngine(KEY, 'm', undefined, f.client, 5000)
    const pending = engine.open({ targetLang: 'sk' })
    await vi.advanceTimersByTimeAsync(0)
    const assertion = expect(pending).rejects.toThrow(/code 1008.*not valid/i)
    f.close(1008, 'API key not valid')
    await assertion
  })

  it('rejects on an error during setup', async () => {
    const f = fakeClient()
    const engine = new GeminiEngine(KEY, 'm', undefined, f.client, 5000)
    const pending = engine.open({ targetLang: 'sk' })
    await vi.advanceTimersByTimeAsync(0)
    const assertion = expect(pending).rejects.toThrow('boom')
    f.error('boom')
    await assertion
  })

  it('never lets the API key into an error message', async () => {
    const f = fakeClient()
    const engine = new GeminiEngine(KEY, 'm', undefined, f.client, 5000)
    const pending = engine.open({ targetLang: 'sk' })
    await vi.advanceTimersByTimeAsync(0)
    f.error(`connect to wss://host/ws?key=${KEY} failed`)
    const err = await pending.catch((e: Error) => e)
    expect((err as Error).message).not.toContain(KEY)
    expect((err as Error).message).toContain('***')
  })
})

describe('GeminiStream', () => {
  it('decodes translated audio and both transcripts', async () => {
    const { f, stream } = await openStream()
    const audio: Buffer[] = []
    const texts: unknown[] = []
    stream.onAudio((b) => audio.push(b))
    stream.onTranscript((t) => texts.push(t))

    f.message(audioMsg([1, 2, 3, 4]))
    f.message({ serverContent: { inputTranscription: { text: 'Hello ', finished: false } } })
    f.message({ serverContent: { outputTranscription: { text: 'Ahoj', finished: true } } })
    f.message({ serverContent: {} }) // nothing to extract

    expect(audio).toEqual([Buffer.from([1, 2, 3, 4])])
    expect(texts).toEqual([
      { kind: 'source', text: 'Hello ', finished: false },
      { kind: 'target', text: 'Ahoj', finished: true },
    ])
  })

  it('sends host audio as 16 kHz PCM once the server confirms setup', async () => {
    const { f, stream } = await openStream()
    stream.pushAudio(Buffer.from([9, 9])) // before setupComplete and within the grace period: held
    expect(f.session.sendRealtimeInput).not.toHaveBeenCalled()

    f.message({ setupComplete: {} })
    stream.pushAudio(Buffer.from([1, 2, 3]))
    expect(f.session.sendRealtimeInput).toHaveBeenCalledWith({
      audio: { data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'audio/pcm;rate=16000' },
    })
  })

  it('sends audio anyway if the server never announces setup', async () => {
    const { f, stream } = await openStream()
    await vi.advanceTimersByTimeAsync(2000)
    stream.pushAudio(Buffer.from([1]))
    expect(f.session.sendRealtimeInput).toHaveBeenCalledTimes(1)
  })

  it('remembers the latest resumable handle and ignores non-resumable updates', async () => {
    const { f, stream } = await openStream()
    expect(stream.resumeHandle()).toBeUndefined()
    f.message({ sessionResumptionUpdate: { newHandle: 'H-1', resumable: true } })
    f.message({ sessionResumptionUpdate: { newHandle: '', resumable: false } })
    f.message({ sessionResumptionUpdate: { newHandle: 'H-bad', resumable: false } })
    expect(stream.resumeHandle()).toBe('H-1')
    f.message({ sessionResumptionUpdate: { newHandle: 'H-2' } })
    expect(stream.resumeHandle()).toBe('H-2')
  })

  it('reports GoAway once as a warning, then a real close separately', async () => {
    const { f, stream } = await openStream()
    const reasons: string[] = []
    stream.onClose((r) => reasons.push(r))
    f.message({ goAway: { timeLeft: '30s' } })
    f.message({ goAway: { timeLeft: '20s' } })
    expect(reasons).toEqual(['goaway'])
    f.close(1000, 'bye')
    expect(reasons).toEqual(['goaway', 'closed'])
    f.close(1000, 'bye again') // only reported once
    expect(reasons).toEqual(['goaway', 'closed'])
  })

  it('reports errors after setup as an error close', async () => {
    const { f, stream } = await openStream()
    const reasons: string[] = []
    stream.onClose((r) => reasons.push(r))
    f.error('socket reset')
    expect(reasons).toEqual(['error'])
  })

  it('stays quiet after an intentional close and stops sending', async () => {
    const { f, stream } = await openStream()
    const reasons: string[] = []
    const audio: Buffer[] = []
    stream.onClose((r) => reasons.push(r))
    stream.onAudio((b) => audio.push(b))
    f.message({ setupComplete: {} })

    stream.close()
    expect(f.session.close).toHaveBeenCalledTimes(1)
    f.close(1000, 'closed by us')
    f.message(audioMsg([1, 2]))
    stream.pushAudio(Buffer.from([1]))

    expect(reasons).toEqual([])
    expect(audio).toEqual([])
    expect(f.session.sendRealtimeInput).not.toHaveBeenCalled()
  })
})

describe('GeminiStream diagnostics', () => {
  it('names what each server message carries', () => {
    expect(messageKinds({ setupComplete: {} } as LiveServerMessage)).toEqual(['setupComplete'])
    expect(messageKinds(audioMsg([1]) as LiveServerMessage)).toEqual(['modelTurn.audio/pcm'])
    expect(
      messageKinds({
        serverContent: { outputTranscription: { text: 'x' }, turnComplete: true, interrupted: false },
        usageMetadata: { totalTokenCount: 3 },
      } as LiveServerMessage),
    ).toEqual(['usageMetadata', 'serverContent.outputTranscription', 'serverContent.turnComplete'])
    expect(messageKinds({} as LiveServerMessage)).toEqual(['empty'])
  })

  it('counts what was sent and received, and which message kinds arrived', async () => {
    const { f, stream } = await openStream()
    f.message({ setupComplete: {} })
    stream.pushAudio(Buffer.alloc(3200))
    stream.pushAudio(Buffer.alloc(3200))
    f.message(audioMsg([1, 2, 3, 4]))
    f.message({ serverContent: { inputTranscription: { text: 'Hello', finished: false } } })
    f.message({ serverContent: { outputTranscription: { text: 'Ahoj svet' } } })
    f.message({ usageMetadata: { promptTokenCount: 10, totalTokenCount: 15 } })
    f.message({ voiceActivity: {} } as Partial<LiveServerMessage>) // something we don't otherwise handle

    const d = stream.diagnostics!() as any
    expect(d.sent).toMatchObject({ chunks: 2, kb: 6, errors: 0 })
    expect(d.received).toMatchObject({ messages: 6, audioChunks: 1, sourceFragments: 1, sourceChars: 5, targetFragments: 1, targetChars: 9 })
    expect(d.messageKinds).toMatchObject({
      setupComplete: 1,
      'modelTurn.audio/pcm': 1,
      'serverContent.inputTranscription': 1,
      'serverContent.outputTranscription': 1,
      usageMetadata: 1,
      voiceActivity: 1,
    })
    expect(d.usage).toEqual({ prompt: 10, total: 15 })
    expect(d.closed).toBe(false)
  })

  it('logs the milestones once, and never the transcript text', async () => {
    const logged = captureLog()
    const { f, stream } = await openStream({}, logged.log)
    f.message({ setupComplete: {} })
    stream.pushAudio(Buffer.alloc(3200))
    stream.pushAudio(Buffer.alloc(3200))
    f.message(audioMsg([1, 2]))
    f.message(audioMsg([3, 4]))
    f.message({ serverContent: { inputTranscription: { text: 'PRIVATE words', languageCode: 'en' } } })
    f.message({ serverContent: { inputTranscription: { text: 'more PRIVATE words' } } })

    const msgs = logged.calls.map((c) => c.msg)
    expect(msgs).toContain('gemini connecting')
    expect(msgs).toContain('gemini connected (server accepted the setup)')
    expect(logged.find('gemini: first audio chunk sent')).toHaveLength(1)
    expect(logged.find('gemini: first translated audio received')).toHaveLength(1)
    expect(logged.find('gemini: first transcript received')).toHaveLength(1)
    expect(logged.find('gemini: first translated audio received')[0]!.o.mime).toBe('audio/pcm;rate=24000')
    expect(JSON.stringify(logged.calls)).not.toContain('PRIVATE')
    expect(JSON.stringify(logged.calls)).not.toContain(KEY)
  })

  it('shows the shape of unexpected messages at debug level', async () => {
    const logged = captureLog()
    const { f } = await openStream({}, logged.log)
    f.message({ serverContent: { waitingForInput: true } })
    const shown = logged.find('gemini: message')
    expect(shown).toHaveLength(1)
    expect(shown[0]!.level).toBe('debug')
    expect(shown[0]!.o.kinds).toEqual(['serverContent.waitingForInput'])
  })

  it('attaches the counters to a close log line', async () => {
    const logged = captureLog()
    const { f, stream } = await openStream({}, logged.log)
    f.message({ setupComplete: {} })
    stream.pushAudio(Buffer.alloc(3200))
    f.close(1011, 'internal error')
    const line = logged.find('gemini stream closed')[0]!
    expect(line.level).toBe('warn')
    expect(line.o.message).toMatch(/1011: internal error/)
    expect(line.o).toMatchObject({ sentChunks: 1, receivedAudioChunks: 0 })
  })
})
