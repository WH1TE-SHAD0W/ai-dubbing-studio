import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionManager, ValidationError } from '../src/session/manager.js'
import { Session } from '../src/session/session.js'
import { FakeConn, FakeEngine, FakeStream, captureLog, loudChunk, silentChunk } from './fakes.js'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const flush = () => vi.advanceTimersByTimeAsync(0)

function setup(targets = ['sk', 'de']) {
  const engine = new FakeEngine()
  let endedReason: string | undefined
  const session = new Session(
    { id: 's1', joinCode: 'KX74M2', title: 'T', sourceLang: 'en', targetLangs: targets, hostName: 'Dr. Novak' },
    { engine, track: { backoffMs: [100, 200, 300] }, onEnded: (_s, r) => (endedReason = r) },
  )
  return { engine, session, endedReason: () => endedReason }
}

async function live(targets?: string[]) {
  const ctx = setup(targets)
  ctx.session.start()
  await flush()
  return ctx
}

describe('starting', () => {
  it('opens one engine stream per target language, once', async () => {
    const { engine, session } = setup()
    expect(session.stats().tracks.map((t) => t.state)).toEqual([]) // nothing before start
    session.start()
    session.start() // idempotent: the studio calls start on every load
    await flush()
    expect(engine.streams.map((s) => s.opts.targetLang).sort()).toEqual(['de', 'sk'])
    expect(session.stats().tracks.map((t) => t.state)).toEqual(['live', 'live'])
    expect(session.status).toBe('live')
  })

  it('refuses listeners until the session is live, and for unknown languages', async () => {
    const { session } = setup()
    expect(session.addListener('sk', new FakeConn())).toBe('not-live')
    session.start()
    await flush()
    expect(session.addListener('xx', new FakeConn())).toBe('no-lang')
    expect(session.addListener('sk', new FakeConn())).toBe('ok')
  })
})

describe('fan-out', () => {
  it('forwards host audio in 100 ms chunks to every language stream', async () => {
    const { engine, session } = await live()
    session.pushHostAudio(Buffer.alloc(6400))
    for (const lang of ['sk', 'de']) {
      const pushed = engine.latest(lang).pushed
      expect(pushed).toHaveLength(2)
      expect(pushed.every((b) => b.length === 3200)).toBe(true)
    }
  })

  it('sends each language only to its own listeners', async () => {
    const { engine, session } = await live()
    const [a, b, c] = [new FakeConn(), new FakeConn(), new FakeConn()]
    session.addListener('sk', a)
    session.addListener('de', b)
    session.addListener('sk', c)

    const audio = Buffer.from([1, 2, 3, 4])
    engine.latest('sk').emitAudio(audio)

    expect(a.binary).toEqual([audio])
    expect(c.binary).toEqual([audio])
    expect(b.binary).toEqual([])
    expect(session.stats().tracks.map((t) => [t.lang, t.listeners])).toEqual([
      ['sk', 2],
      ['de', 1],
    ])
    expect(session.stats().listeners).toBe(3)
  })

  it('lets a listener switch language without any new engine work', async () => {
    const { engine, session } = await live()
    const a = new FakeConn()
    session.addListener('sk', a)
    const opened = engine.streams.length

    expect(session.moveListener(a, 'de')).toBe(true)
    engine.latest('sk').emitAudio(Buffer.from([1]))
    engine.latest('de').emitAudio(Buffer.from([2]))

    expect(a.binary).toEqual([Buffer.from([2])])
    expect(engine.streams).toHaveLength(opened)
    expect(session.stats().tracks.map((t) => t.listeners)).toEqual([0, 1])
    expect(session.moveListener(a, 'xx')).toBe(false)
  })

  it('drops frames for a listener that is far behind instead of buffering', async () => {
    const { engine, session } = await live()
    const slow = new FakeConn()
    session.addListener('sk', slow)
    slow.buffered = 300 * 1024
    engine.latest('sk').emitAudio(Buffer.from([1]))
    expect(slow.binary).toHaveLength(0)
    slow.buffered = 0
    engine.latest('sk').emitAudio(Buffer.from([2]))
    expect(slow.binary).toHaveLength(1)
  })

  it('forgets a listener that disconnects', async () => {
    const { engine, session } = await live()
    const a = new FakeConn()
    session.addListener('sk', a)
    session.removeListener(a)
    engine.latest('sk').emitAudio(Buffer.from([1]))
    expect(a.binary).toHaveLength(0)
    expect(session.stats().listeners).toBe(0)
  })
})

describe('captions and speaking', () => {
  it('sends translated text per language and source text from one track only', async () => {
    const { engine, session } = await live()
    const sk = new FakeConn()
    const de = new FakeConn()
    session.addListener('sk', sk)
    session.addListener('de', de)

    engine.latest('sk').emitTranscript({ kind: 'target', text: 'Ahoj' })
    engine.latest('de').emitTranscript({ kind: 'target', text: 'Hallo' })
    engine.latest('de').emitTranscript({ kind: 'source', text: 'ignored: not the primary track' })
    engine.latest('sk').emitTranscript({ kind: 'source', text: 'Hello' })

    expect(sk.last('caption')).toEqual({ type: 'caption', original: 'Hello', translated: 'Ahoj' })
    expect(de.last('caption')).toEqual({ type: 'caption', original: 'Hello', translated: 'Hallo' })
  })

  it('sends the host every language at once', async () => {
    const { engine, session } = await live()
    const host = new FakeConn()
    session.setHost(host)
    engine.latest('sk').emitTranscript({ kind: 'target', text: 'Ahoj' })
    expect(host.last('caption')).toEqual({ type: 'caption', original: '', translated: { sk: 'Ahoj', de: '' } })
  })

  it('tells listeners when the host starts and stops speaking', async () => {
    const { session } = await live()
    const a = new FakeConn()
    session.addListener('sk', a)
    expect(a.last('speaker')).toEqual({ type: 'speaker', speaking: false })

    session.pushHostAudio(loudChunk())
    expect(a.last('speaker')).toEqual({ type: 'speaker', speaking: true })

    await vi.advanceTimersByTimeAsync(1000)
    expect(a.last('speaker')).toEqual({ type: 'speaker', speaking: false })
  })

  it('estimates latency from end of speech to the end of the translated output', async () => {
    const { engine, session } = await live(['sk'])
    expect(session.stats().latencyMs).toBeNull()

    session.pushHostAudio(loudChunk()) // speech ends at t0
    await vi.advanceTimersByTimeAsync(1500) // host goes quiet
    engine.latest('sk').emitAudio(loudChunk()) // translated audio keeps arriving after speech ended
    await vi.advanceTimersByTimeAsync(1500) // output goes quiet

    const latency = session.stats().latencyMs!
    expect(latency).toBeGreaterThan(1300)
    expect(latency).toBeLessThan(1700)
  })

  it('ignores silent output frames when measuring latency', async () => {
    const { engine, session } = await live(['sk'])
    session.pushHostAudio(loudChunk())
    await vi.advanceTimersByTimeAsync(1500)
    engine.latest('sk').emitAudio(loudChunk()) // the translated words
    // An engine that keeps streaming silence afterwards must not stretch the measurement.
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(150)
      engine.latest('sk').emitAudio(Buffer.alloc(4800))
    }
    const latency = session.stats().latencyMs!
    expect(latency).toBeGreaterThan(1300)
    expect(latency).toBeLessThan(1700)
  })
})

describe('failure handling', () => {
  it('reopens a dropped stream, resuming from its handle', async () => {
    const { engine, session } = await live()
    const a = new FakeConn()
    session.addListener('sk', a)
    const first = engine.latest('sk')
    first.handle = 'HANDLE-1'

    first.emitClose('closed')
    expect(session.stats().tracks[0]!.state).toBe('degraded')
    expect(a.last('status')).toEqual({ type: 'status', trackDown: true })

    await vi.advanceTimersByTimeAsync(150)
    expect(engine.forLang('sk')).toHaveLength(2)
    expect(engine.latest('sk').opts.resumeHandle).toBe('HANDLE-1')
    expect(session.stats().tracks[0]!.state).toBe('live')
    expect(a.last('status')).toEqual({ type: 'status', trackDown: false })
    expect(session.stats().tracks[1]!.state).toBe('live') // the other language never noticed
  })

  it('gives up after three failed reopens, then recovers on manual retry', async () => {
    const { engine, session } = await live(['sk'])
    engine.failOpens = 99
    engine.latest('sk').emitClose('error')
    await vi.advanceTimersByTimeAsync(700)
    expect(session.stats().tracks[0]!.state).toBe('error')

    engine.failOpens = 0
    expect(session.retryTrack('sk')).toBe(true)
    await flush()
    expect(session.stats().tracks[0]!.state).toBe('live')
    expect(session.retryTrack('sk')).toBe(false) // nothing to retry on a healthy track
  })

  it('gives up on a stream that opens and dies straight away instead of reconnecting forever', async () => {
    const { engine, session } = await live(['sk'])
    // Every stream that opens is dead within a second (a bad model name, say).
    const origOpen = engine.open.bind(engine)
    engine.open = async (o) => {
      const s = await origOpen(o)
      setTimeout(() => (s as FakeStream).emitClose('closed'), 1000)
      return s
    }
    engine.latest('sk').emitClose('closed')
    await vi.advanceTimersByTimeAsync(20_000)

    expect(session.stats().tracks[0]!.state).toBe('error')
    const opened = engine.forLang('sk').length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(engine.forLang('sk')).toHaveLength(opened) // and it stopped trying
    expect(opened).toBeLessThanOrEqual(5)
  })

  it('forgets earlier failures once a stream has been healthy for a while', async () => {
    const { engine, session } = await live(['sk'])
    for (let i = 0; i < 6; i++) {
      engine.latest('sk').emitClose('closed')
      await vi.advanceTimersByTimeAsync(150) // reopened
      await vi.advanceTimersByTimeAsync(11_000) // and then healthy for longer than the stability window
    }
    expect(session.stats().tracks[0]!.state).toBe('live')
  })

  it('reports engine failures to the log', async () => {
    const warnings: any[] = []
    const engine = new FakeEngine()
    engine.failOpens = 1
    const session = new Session(
      { id: 's1', joinCode: 'KX74M2', title: 'T', sourceLang: 'en', targetLangs: ['sk'], hostName: 'H' },
      { engine, track: { backoffMs: [100] }, log: { warn: (o, msg) => warnings.push({ ...o, msg }) } },
    )
    session.start()
    await flush()
    expect(warnings).toEqual([{ session: 's1', lang: 'sk', message: 'open failed', msg: 'engine failure' }])
  })

  it('on GoAway opens a replacement before retiring the old stream', async () => {
    const { engine, session } = await live(['sk'])
    const a = new FakeConn()
    session.addListener('sk', a)
    const old = engine.latest('sk')

    old.emitClose('goaway')
    await flush()

    expect(engine.forLang('sk')).toHaveLength(2)
    expect(old.closed).toBe(true)
    expect(session.stats().tracks[0]!.state).toBe('live')

    old.emitAudio(Buffer.from([9])) // a retired stream must not reach listeners
    engine.latest('sk').emitAudio(Buffer.from([7]))
    expect(a.binary).toEqual([Buffer.from([7])])
  })

  it('keeps one language failing from affecting the others', async () => {
    const { engine, session } = await live()
    engine.failOpens = 99
    engine.latest('de').emitClose('error')
    await vi.advanceTimersByTimeAsync(700)
    expect(session.stats().tracks.map((t) => t.state)).toEqual(['live', 'error'])
  })
})

describe('diagnostics and logging', () => {
  function liveWithLog(targets = ['sk']) {
    const engine = new FakeEngine()
    const logged = captureLog()
    const session = new Session(
      { id: 's1', joinCode: 'KX74M2', title: 'T', sourceLang: 'en', targetLangs: targets, hostName: 'H' },
      { engine, track: { backoffMs: [100] }, log: logged.log },
    )
    session.start()
    return { engine, session, ...logged }
  }

  it('warns when Gemini says nothing back despite speech, with the likely cause', async () => {
    const { engine, session, find } = liveWithLog()
    await flush()
    for (let i = 0; i < 80; i++) session.pushHostAudio(loudChunk()) // 8 s of speech
    await vi.advanceTimersByTimeAsync(300)

    const warnings = find('gemini is not responding to speech')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.o.lang).toBe('sk')
    expect(warnings[0]!.o.speechSecondsWithoutOutput).toBe(8)
    expect(warnings[0]!.o.likelyCause).toMatch(/sent nothing back/i)
    expect(warnings[0]!.o.gemini.sent.chunks).toBe(80)

    // rate-limited, not once per tick
    await vi.advanceTimersByTimeAsync(5000)
    expect(find('gemini is not responding to speech')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(11_000)
    expect(find('gemini is not responding to speech').length).toBeGreaterThanOrEqual(2)
    expect(engine.latest('sk').pushed).toHaveLength(80)
  })

  it('distinguishes "replies without audio" from "sent nothing"', async () => {
    const { engine, session, find } = liveWithLog()
    await flush()
    engine.latest('sk').received = { messages: 40, audioChunks: 0 }
    for (let i = 0; i < 80; i++) session.pushHostAudio(loudChunk())
    await vi.advanceTimersByTimeAsync(300)
    expect(find('gemini is not responding to speech')[0]!.o.likelyCause).toMatch(/without audio/i)
  })

  it('stays quiet while translated audio keeps arriving', async () => {
    const { engine, session, find } = liveWithLog()
    await flush()
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 30; i++) session.pushHostAudio(loudChunk())
      engine.latest('sk').emitAudio(loudChunk()) // translation keeps coming back
      await vi.advanceTimersByTimeAsync(300)
    }
    expect(find('gemini is not responding to speech')).toHaveLength(0)
  })

  it('does not warn about quiet rooms: only loud (speech-like) chunks count', async () => {
    const { session, find } = liveWithLog()
    await flush()
    for (let i = 0; i < 200; i++) session.pushHostAudio(silentChunk())
    await vi.advanceTimersByTimeAsync(300)
    expect(find('gemini is not responding to speech')).toHaveLength(0)
  })

  it('warns when the host is connected but no audio frames arrive', async () => {
    const { session, find } = liveWithLog()
    await flush()
    session.setHost(new FakeConn())
    await vi.advanceTimersByTimeAsync(4000)
    expect(find('host is connected but no audio frames are arriving')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2500)
    expect(find('host is connected but no audio frames are arriving')).toHaveLength(1)
  })

  it('warns when host audio arrives but is silent', async () => {
    const { session, find } = liveWithLog()
    await flush()
    session.setHost(new FakeConn())
    for (let i = 0; i < 130; i++) {
      session.pushHostAudio(silentChunk())
      await vi.advanceTimersByTimeAsync(100)
    }
    const w = find('host audio is arriving but it is silent')
    expect(w).toHaveLength(1)
    expect(w[0]!.o.maxRms).toBe(0)
  })

  it('reports counters and levels in the debug snapshot', async () => {
    const { engine, session } = liveWithLog(['sk', 'de'])
    await flush()
    const listener = new FakeConn()
    session.addListener('sk', listener)
    session.setHost(new FakeConn())
    for (let i = 0; i < 5; i++) session.pushHostAudio(loudChunk())
    session.pushHostAudio(silentChunk())
    engine.latest('sk').emitAudio(loudChunk())
    engine.latest('sk').emitTranscript({ kind: 'target', text: 'Ahoj' })

    const snap = session.debugSnapshot()
    expect(snap.status).toBe('live')
    expect(snap.host).toMatchObject({ connected: true, frames: 6, chunks100ms: 6, loudChunks: 5 })
    expect(snap.host.maxRms).toBeGreaterThan(0.2)
    expect(snap.relay).toMatchObject({ audioChunksToListeners: 1 })
    const sk = snap.tracks.find((t: any) => t.lang === 'sk') as any
    expect(sk).toMatchObject({ state: 'live', listeners: 1 })
    expect(sk.relay).toMatchObject({ chunksSentToGemini: 6, loudChunksSent: 5, audioChunksFromGemini: 1, audibleAudioChunks: 1, transcriptFragmentsFromGemini: 1 })
    expect(JSON.stringify(snap)).not.toContain('Ahoj') // counts only, never content
  })

  it('logs lifecycle events but never audio or transcript text', async () => {
    const { engine, session, calls, find } = liveWithLog()
    await flush()
    session.setHost(new FakeConn())
    session.pushHostAudio(loudChunk())
    engine.latest('sk').emitTranscript({ kind: 'source', text: 'TOP-SECRET-SPEECH' })
    engine.latest('sk').emitTranscript({ kind: 'target', text: 'TOP-SECRET-TRANSLATION' })
    engine.latest('sk').emitAudio(loudChunk())
    await vi.advanceTimersByTimeAsync(6000) // a periodic report
    session.end('host-ended')

    expect(find('session started')).toHaveLength(1)
    expect(find('host connected')).toHaveLength(1)
    expect(find('host audio: first frame received')).toHaveLength(1)
    expect(find('session report').length).toBeGreaterThan(0)
    expect(find('session ended')[0]!.o.reason).toBe('host-ended')
    expect(find('track state changed').map((c) => c.o.to)).toContain('live')
    expect(JSON.stringify(calls)).not.toContain('TOP-SECRET')
    expect(calls.every((c) => c.o.session === 's1')).toBe(true) // every line is traceable to its session
  })
})

describe('ending', () => {
  it('closes every stream and tells everyone', async () => {
    const { engine, session, endedReason } = await live()
    const a = new FakeConn()
    const host = new FakeConn()
    session.addListener('sk', a)
    session.setHost(host)

    session.end('host-ended')

    expect(engine.streams.every((s) => s.closed)).toBe(true)
    expect(a.last('ended')).toEqual({ type: 'ended' })
    expect(a.closedWith?.code).toBe(1000)
    expect(host.closedWith?.code).toBe(1000)
    expect(endedReason()).toBe('host-ended')
    expect(session.addListener('sk', new FakeConn())).toBe('not-live')

    session.pushHostAudio(Buffer.alloc(3200)) // no-op after the end
    expect(engine.latest('sk').pushed).toHaveLength(0)
    session.end() // idempotent
  })

  it('does not reopen streams after the session ended', async () => {
    const { engine, session } = await live(['sk'])
    const s = engine.latest('sk')
    session.end()
    s.emitClose('closed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(engine.forLang('sk')).toHaveLength(1)
  })

  it('replaces the host connection, and ignores the old one leaving', async () => {
    const { session } = await live()
    const h1 = new FakeConn()
    const h2 = new FakeConn()
    session.setHost(h1)
    session.setHost(h2)
    expect(h1.closedWith?.code).toBe(4000)
    session.hostLeft(h1)
    expect(session.hasHost).toBe(true)
    expect(session.hostGoneAt).toBeNull()
    session.hostLeft(h2)
    expect(session.hasHost).toBe(false)
    expect(session.hostGoneAt).not.toBeNull()
  })
})

describe('SessionManager', () => {
  const cfg = { maxSessionMinutes: 1, hostGraceMs: 1000, maxTargets: 5, hostName: 'Dr. Novak' }
  const make = () => {
    const engine = new FakeEngine()
    return { engine, manager: new SessionManager(cfg, engine, { track: { backoffMs: [10] } }) }
  }
  const input = { title: ' Ethics 101 ', sourceLang: 'en', targetLangs: ['sk', 'de'] }

  it('creates sessions with a code, trimming the title', () => {
    const { manager } = make()
    const s = manager.create(input)
    expect(s.title).toBe('Ethics 101')
    expect(s.joinCode).toMatch(/^[A-Z2-9]{6}$/)
    expect(manager.get(s.id)).toBe(s)
  })

  it.each([
    ['empty title', { title: '  ' }],
    ['no targets', { targetLangs: [] }],
    ['too many targets', { targetLangs: ['sk', 'de', 'es', 'fr', 'uk', 'pl'] }],
    ['source as target', { targetLangs: ['en', 'sk'] }],
    ['invalid language code', { targetLangs: ['Slovak!'] }],
    ['invalid source', { sourceLang: '' }],
  ])('rejects %s', (_name, patch) => {
    expect(() => make().manager.create({ ...input, ...patch })).toThrow(ValidationError)
  })

  it('de-duplicates targets', () => {
    expect(make().manager.create({ ...input, targetLangs: ['sk', 'sk', 'de'] }).targetLangs).toEqual(['sk', 'de'])
  })

  it('only lets listeners find live sessions', async () => {
    const { manager } = make()
    const s = manager.create(input)
    expect(manager.getLiveByCode(s.joinCode)).toBeUndefined() // draft
    s.start()
    expect(manager.getLiveByCode(s.joinCode.toLowerCase())).toBe(s)
    s.end()
    expect(manager.getLiveByCode(s.joinCode)).toBeUndefined()
    expect(manager.get(s.id)).toBeUndefined() // forgotten once ended
  })

  it('ends a live session whose host has been gone past the grace period', () => {
    const { manager } = make()
    const s = manager.create(input)
    s.start()
    vi.advanceTimersByTime(500)
    manager.reap()
    expect(s.status).toBe('live')
    vi.advanceTimersByTime(600)
    manager.reap()
    expect(s.status).toBe('ended')
  })

  it('keeps a session alive while the host stays connected', () => {
    const { manager } = make()
    const s = manager.create(input)
    s.start()
    s.setHost(new FakeConn())
    vi.advanceTimersByTime(30_000)
    manager.reap()
    expect(s.status).toBe('live')
  })

  it('ends a session at the maximum duration even with a host connected', () => {
    const { manager } = make()
    const s = manager.create(input)
    s.start()
    s.setHost(new FakeConn())
    vi.advanceTimersByTime(61_000)
    manager.reap()
    expect(s.status).toBe('ended')
  })

  it('drops sessions that were created but never started', () => {
    const { manager } = make()
    const s = manager.create(input)
    vi.advanceTimersByTime(31 * 60_000)
    manager.reap()
    expect(manager.get(s.id)).toBeUndefined()
  })

  it('ends everything on shutdown, closing all engine streams', async () => {
    const { manager, engine } = make()
    manager.create(input).start()
    manager.create(input).start()
    await flush()
    manager.endAll()
    expect(engine.streams.length).toBe(4)
    expect(engine.streams.every((s) => s.closed)).toBe(true)
  })
})
