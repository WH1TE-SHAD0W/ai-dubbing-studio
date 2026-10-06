// Runs the REAL @google/genai SDK against a local mock of Gemini's Live WebSocket, so the wire
// format (setup message, realtimeInput, server messages, close codes) is exercised end to end
// without a key. The mock follows Google's documented message shapes; it is not Google's server,
// so this proves our adapter and logging, not the live service's behaviour.
import { GoogleGenAI } from '@google/genai'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as WS } from 'ws'
import { GeminiEngine } from '../src/engine/gemini.js'
import { Session } from '../src/session/session.js'
import { FakeConn, captureLog, loudChunk } from './fakes.js'

type Behaviour = 'silent' | 'echo' | 'close-after-setup'

let server: WebSocketServer
let baseUrl: string
let behaviour: Behaviour
let setups: any[]
let realtimeInputs: any[]
let paths: string[]

beforeEach(async () => {
  behaviour = 'echo'
  setups = []
  realtimeInputs = []
  paths = []
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => server.once('listening', () => r()))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  server.on('connection', (sock: WS, req) => {
    paths.push(req.url ?? '')
    sock.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.setup) {
        setups.push(msg.setup)
        sock.send(JSON.stringify({ setupComplete: {} }))
        if (behaviour === 'close-after-setup') setTimeout(() => sock.close(1011, 'model overloaded'), 50)
      } else if (msg.realtimeInput) {
        realtimeInputs.push(msg.realtimeInput)
        if (behaviour === 'echo') {
          const pcm24k = Buffer.alloc(4800, 7)
          sock.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm24k.toString('base64') } }] } } }))
          sock.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'Hello there', finished: false } } }))
          sock.send(JSON.stringify({ serverContent: { outputTranscription: { text: 'Ahoj tam', finished: true } } }))
          sock.send(JSON.stringify({ usageMetadata: { promptTokenCount: 12, totalTokenCount: 30 } }))
        }
      }
    })
  })
})

afterEach(async () => {
  for (const c of server.clients) c.terminate()
  await new Promise<void>((r) => server.close(() => r()))
})

const engineWith = (log = captureLog()) => {
  const client = new GoogleGenAI({ apiKey: 'mock-key', httpOptions: { baseUrl } })
  return { engine: new GeminiEngine('mock-key', 'gemini-3.5-live-translate-preview', log.log, client as never, 5000), log }
}

const until = async (fn: () => unknown) => {
  const t0 = Date.now()
  for (;;) {
    try {
      return fn()
    } catch (e) {
      if (Date.now() - t0 > 3000) throw e
      await new Promise((r) => setTimeout(r, 15))
    }
  }
}

describe('GeminiEngine with the real SDK against a mock Live server', () => {
  it('sends a setup message that asks for continuous audio translation into the target language', async () => {
    const { engine } = engineWith()
    const stream = await engine.open({ targetLang: 'sk' })
    const setup = setups[0]
    expect(paths[0]).toMatch(/BidiGenerateContent\?key=mock-key/)
    expect(setup.model).toBe('models/gemini-3.5-live-translate-preview')
    expect(setup.generationConfig.responseModalities).toEqual(['AUDIO'])
    expect(setup.generationConfig.translationConfig).toEqual({ targetLanguageCode: 'sk', echoTargetLanguage: false })
    expect(setup.inputAudioTranscription).toEqual({})
    expect(setup.outputAudioTranscription).toEqual({})
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} })
    expect(setup.sessionResumption).toEqual({})
    stream.close()
  })

  it('sends host audio as 16 kHz PCM realtimeInput', async () => {
    const { engine } = engineWith()
    const stream = await engine.open({ targetLang: 'sk' })
    stream.pushAudio(Buffer.from([1, 2, 3, 4]))
    await until(() => expect(realtimeInputs).toHaveLength(1))
    expect(realtimeInputs[0].audio).toEqual({ mimeType: 'audio/pcm;rate=16000', data: Buffer.from([1, 2, 3, 4]).toString('base64') })
    stream.close()
  })

  it('decodes translated audio, transcripts and usage from real SDK-parsed messages', async () => {
    const { engine } = engineWith()
    const stream = await engine.open({ targetLang: 'sk' })
    const audio: Buffer[] = []
    const texts: unknown[] = []
    stream.onAudio((b) => audio.push(b))
    stream.onTranscript((t) => texts.push(t))

    stream.pushAudio(loudChunk())
    await until(() => expect(audio).toHaveLength(1))
    await until(() => expect(texts).toHaveLength(2))

    expect(audio[0]!.equals(Buffer.alloc(4800, 7))).toBe(true)
    expect(texts).toEqual([
      { kind: 'source', text: 'Hello there', finished: false },
      { kind: 'target', text: 'Ahoj tam', finished: true },
    ])
    const d = stream.diagnostics!() as any
    expect(d.received).toMatchObject({ audioChunks: 1, sourceFragments: 1, targetFragments: 1 })
    expect(d.messageKinds).toMatchObject({ setupComplete: 1, 'modelTurn.audio/pcm': 1, usageMetadata: 1 })
    expect(d.usage).toEqual({ prompt: 12, total: 30 })
    stream.close()
  })

  it('reports a server-initiated close with its code and reason', async () => {
    behaviour = 'close-after-setup'
    const { engine, log } = engineWith()
    const stream = await engine.open({ targetLang: 'sk' })
    const reasons: string[] = []
    stream.onClose((r) => reasons.push(r))
    await until(() => expect(reasons).toEqual(['closed']))
    const line = log.find('gemini stream closed')[0]!
    expect(line.o.message).toMatch(/1011: model overloaded/)
  })
})

describe('the "connected but Gemini stays silent" case, end to end', () => {
  it('connects, streams speech, gets nothing back, and the logs say so', async () => {
    behaviour = 'silent'
    const { engine, log } = engineWith()
    const session = new Session(
      { id: 's1', joinCode: 'KX74M2', title: 'T', sourceLang: 'en', targetLangs: ['sk'], hostName: 'H' },
      { engine, track: { backoffMs: [100] }, log: log.log },
    )
    session.start()
    await until(() => expect(session.stats().tracks[0]!.state).toBe('live'))
    session.setHost(new FakeConn())
    await new Promise((r) => setTimeout(r, 1600)) // let the setup grace period pass so audio is actually sent

    for (let i = 0; i < 85; i++) session.pushHostAudio(loudChunk()) // 8.5 s of speech
    await until(() => expect(log.find('gemini is not responding to speech')).toHaveLength(1))

    // The healthy-looking facts...
    expect(session.stats().tracks[0]!.state).toBe('live')
    expect(log.find('gemini connected (server accepted the setup)')).toHaveLength(1)
    expect(log.find('gemini: first audio chunk sent')).toHaveLength(1)
    // ...and the diagnosis.
    const warning = log.find('gemini is not responding to speech')[0]!
    expect(warning.o.likelyCause).toMatch(/sent nothing back/i)
    expect(warning.o.gemini.sent.chunks).toBe(85)
    expect(warning.o.gemini.received.messages).toBe(1) // only the setupComplete
    expect(log.find('gemini: first translated audio received')).toHaveLength(0)

    const snap = session.debugSnapshot()
    expect(snap.tracks[0]).toMatchObject({ state: 'live', relay: { chunksSentToGemini: 85, audioChunksFromGemini: 0 } })
    session.end()
  })

  it('does not warn when Gemini answers', async () => {
    behaviour = 'echo'
    const { engine, log } = engineWith()
    const session = new Session(
      { id: 's1', joinCode: 'KX74M2', title: 'T', sourceLang: 'en', targetLangs: ['sk'], hostName: 'H' },
      { engine, log: log.log },
    )
    session.start()
    await until(() => expect(session.stats().tracks[0]!.state).toBe('live'))
    await new Promise((r) => setTimeout(r, 1600))
    for (let i = 0; i < 85; i++) {
      session.pushHostAudio(loudChunk())
      await new Promise((r) => setTimeout(r, 2))
    }
    await until(() => expect(log.find('gemini: first translated audio received')).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 400))
    expect(log.find('gemini is not responding to speech')).toHaveLength(0)
    session.end()
  })
})
