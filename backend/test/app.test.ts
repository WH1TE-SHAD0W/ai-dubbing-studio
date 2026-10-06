import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { buildApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import type { SessionManager } from '../src/session/manager.js'
import { FakeEngine, loudChunk } from './fakes.js'

const config: Config = {
  port: 0,
  geminiApiKey: 'test',
  geminiModel: 'test-model',
  hostEmail: 'host@example.com',
  hostPassword: 'correct horse',
  hostName: 'Dr. Novak',
  sessionSecret: 'test-secret',
  maxSessionMinutes: 240,
  hostGraceMs: 60_000,
  maxTargets: 5,
  logLevel: 'silent',
}

let app: FastifyInstance
let manager: SessionManager
let engine: FakeEngine
let http: string
let ws: string
const sockets: WebSocket[] = []

beforeEach(async () => {
  engine = new FakeEngine()
  ;({ app, manager } = await buildApp({ config, engine, track: { backoffMs: [20] } }))
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  http = `http://127.0.0.1:${port}`
  ws = `ws://127.0.0.1:${port}`
})

afterEach(async () => {
  sockets.splice(0).forEach((s) => s.terminate())
  manager.endAll()
  await app.close()
})

// ---- helpers ----

const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function signIn(): Promise<string> {
  const res = await fetch(`${http}/auth/signin`, json({ email: 'host@example.com', password: config.hostPassword }))
  expect(res.status).toBe(200)
  return res.headers.get('set-cookie')!.split(';')[0]!
}

const consent = { speaker: true, aiNotice: true, textVersion: 'v1' }
const sessionBody = { title: 'Ethics 101', sourceLang: 'en', targetLangs: ['sk', 'de'], consent }

async function createAndStart(cookie: string) {
  const created = await fetch(`${http}/sessions`, { ...json(sessionBody), headers: { 'Content-Type': 'application/json', cookie } })
  expect(created.status).toBe(200)
  const { id, joinCode } = (await created.json()) as { id: string; joinCode: string }
  const started = await fetch(`${http}/sessions/${id}/start`, { method: 'POST', headers: { cookie } })
  expect(started.status).toBe(200)
  return { id, joinCode, started: (await started.json()) as { startedAt: number } }
}

interface Client {
  ws: WebSocket
  binary: Buffer[]
  json: any[]
  closed: Promise<number>
}

function connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers })
    sockets.push(socket)
    const client: Client = { ws: socket, binary: [], json: [], closed: undefined as unknown as Promise<number> }
    client.closed = new Promise((r) => socket.on('close', (code) => r(code)))
    socket.on('message', (data, isBinary) => {
      if (isBinary) client.binary.push(data as Buffer)
      else client.json.push(JSON.parse(data.toString()))
    })
    socket.on('open', () => resolve(client))
    socket.on('error', reject)
  })
}

const until = (fn: () => unknown) => vi.waitFor(fn, { timeout: 2000, interval: 10 })

// ---- auth ----

describe('auth', () => {
  it('protects host endpoints', async () => {
    expect((await fetch(`${http}/sessions`, json(sessionBody))).status).toBe(401)
    expect((await fetch(`${http}/sessions/x/start`, { method: 'POST' })).status).toBe(401)
    expect((await fetch(`${http}/sessions/x/stats`)).status).toBe(401)
  })

  it('signs in with a signed httpOnly cookie and returns the host name', async () => {
    const res = await fetch(`${http}/auth/signin`, json({ email: 'host@example.com', password: config.hostPassword }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: 'Dr. Novak' })
    expect(res.headers.get('set-cookie')).toMatch(/ads_session=.+; HttpOnly; SameSite=Lax/)
  })

  it('marks the cookie Secure behind an https proxy', async () => {
    const res = await fetch(`${http}/auth/signin`, {
      ...json({ email: 'host@example.com', password: config.hostPassword }),
      headers: { 'Content-Type': 'application/json', 'x-forwarded-proto': 'https' },
    })
    expect(res.headers.get('set-cookie')).toMatch(/; Secure/)
  })

  it('rejects wrong credentials and malformed bodies, then rate-limits', async () => {
    const bad = json({ email: 'host@example.com', password: 'nope' })
    expect((await fetch(`${http}/auth/signin`, bad)).status).toBe(401)
    expect((await fetch(`${http}/auth/signin`, json({}))).status).toBe(401)
    expect((await fetch(`${http}/auth/signin`, json({ email: 1, password: 2 }))).status).toBe(401)
    expect((await fetch(`${http}/auth/signin`, bad)).status).toBe(401)
    expect((await fetch(`${http}/auth/signin`, bad)).status).toBe(401)
    expect((await fetch(`${http}/auth/signin`, bad)).status).toBe(429)
  })

  it('clears the cookie on sign-out', async () => {
    const res = await fetch(`${http}/auth/signout`, { method: 'POST' })
    expect(res.status).toBe(204)
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/)
  })
})

// ---- sessions ----

describe('sessions', () => {
  it('requires both consents', async () => {
    const cookie = await signIn()
    for (const bad of [{}, { speaker: true }, { speaker: true, aiNotice: false, textVersion: 'v1' }]) {
      const res = await fetch(`${http}/sessions`, { ...json({ ...sessionBody, consent: bad }), headers: { 'Content-Type': 'application/json', cookie } })
      expect(res.status).toBe(400)
    }
  })

  it('validates languages and title', async () => {
    const cookie = await signIn()
    const post = (body: unknown) => fetch(`${http}/sessions`, { ...json(body), headers: { 'Content-Type': 'application/json', cookie } })
    expect((await post({ ...sessionBody, title: '' })).status).toBe(400)
    expect((await post({ ...sessionBody, targetLangs: [] })).status).toBe(400)
    expect((await post({ ...sessionBody, targetLangs: ['en'] })).status).toBe(400)
    expect((await post({ ...sessionBody, targetLangs: 'sk' })).status).toBe(400)
    const res = await post({ ...sessionBody, targetLangs: ['sk', 'de', 'es', 'fr', 'uk', 'pl'] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { message: string }).message).toMatch(/at most 5/i)
  })

  it('starts idempotently and only then lets listeners look the code up', async () => {
    const cookie = await signIn()
    const created = await (await fetch(`${http}/sessions`, { ...json(sessionBody), headers: { 'Content-Type': 'application/json', cookie } })).json() as { id: string; joinCode: string }

    expect((await fetch(`${http}/join/${created.joinCode}`)).status).toBe(404) // draft isn't joinable

    const first = await (await fetch(`${http}/sessions/${created.id}/start`, { method: 'POST', headers: { cookie } })).json() as { startedAt: number; sourceLang: string; title: string }
    const second = await (await fetch(`${http}/sessions/${created.id}/start`, { method: 'POST', headers: { cookie } })).json() as { startedAt: number }
    expect(second.startedAt).toBe(first.startedAt)
    expect(first.sourceLang).toBe('en')
    expect(engine.streams).toHaveLength(2) // started once, not twice

    const join = await fetch(`${http}/join/${created.joinCode.toLowerCase()}`)
    expect(join.status).toBe(200)
    expect(await join.json()).toEqual({ title: 'Ethics 101', speakerName: 'Dr. Novak', sourceLang: 'en', languages: ['sk', 'de'] })
    expect((await fetch(`${http}/join/ZZZZZZ`)).status).toBe(404)
    expect((await fetch(`${http}/sessions/nope/start`, { method: 'POST', headers: { cookie } })).status).toBe(404)
  })

  it('accepts bodyless POSTs even when the client sends a JSON content type', async () => {
    const cookie = await signIn()
    const created = await (await fetch(`${http}/sessions`, { ...json(sessionBody), headers: { 'Content-Type': 'application/json', cookie } })).json() as { id: string }
    const asJson = { 'Content-Type': 'application/json', cookie }
    expect((await fetch(`${http}/sessions/${created.id}/start`, { method: 'POST', headers: asJson })).status).toBe(200)
    expect((await fetch(`${http}/sessions/${created.id}/end`, { method: 'POST', headers: asJson })).status).toBe(204)
  })

  it('answers malformed JSON with a clean 400', async () => {
    const res = await fetch(`${http}/auth/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { message: string }).message).toBe('Invalid JSON.')
  })

  it('ends idempotently', async () => {
    const cookie = await signIn()
    const { id, joinCode } = await createAndStart(cookie)
    expect((await fetch(`${http}/sessions/${id}/end`, { method: 'POST', headers: { cookie } })).status).toBe(204)
    expect((await fetch(`${http}/sessions/${id}/end`, { method: 'POST', headers: { cookie } })).status).toBe(204)
    expect((await fetch(`${http}/join/${joinCode}`)).status).toBe(404)
    expect(engine.streams.every((s) => s.closed)).toBe(true)
  })

  it('rate-limits join lookups', async () => {
    let last = 0
    for (let i = 0; i < 31; i++) last = (await fetch(`${http}/join/ZZZZZZ`)).status
    expect(last).toBe(429)
  })

  it('streams stats as Server-Sent Events', async () => {
    const cookie = await signIn()
    const { id } = await createAndStart(cookie)
    const res = await fetch(`${http}/sessions/${id}/stats`, { headers: { cookie } })
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    await reader.cancel()
    const text = new TextDecoder().decode(value)
    expect(text.startsWith('data: ')).toBe(true)
    const stats = JSON.parse(text.slice(6)) as { listeners: number; latencyMs: number | null; tracks: { lang: string; state: string }[] }
    expect(stats.listeners).toBe(0)
    expect(stats.latencyMs).toBeNull()
    expect(stats.tracks.map((t) => [t.lang, t.state])).toEqual([['sk', 'live'], ['de', 'live']])
  })

  it('exposes a host-only debug snapshot with counters', async () => {
    const cookie = await signIn()
    const { id } = await createAndStart(cookie)
    expect((await fetch(`${http}/sessions/${id}/debug`)).status).toBe(401)
    expect((await fetch(`${http}/sessions/nope/debug`, { headers: { cookie } })).status).toBe(404)

    const host = await connect(`${ws}/ws/host/${id}`, { cookie })
    host.ws.send(loudChunk())
    host.ws.send(loudChunk())
    await until(() => expect(engine.latest('sk').pushed).toHaveLength(2))

    const res = await fetch(`${http}/sessions/${id}/debug`, { headers: { cookie } })
    expect(res.status).toBe(200)
    const snap = (await res.json()) as any
    expect(snap.host).toMatchObject({ connected: true, frames: 2, loudChunks: 2 })
    expect(snap.tracks.map((t: any) => [t.lang, t.state])).toEqual([['sk', 'live'], ['de', 'live']])
    expect(snap.tracks[0].relay.chunksSentToGemini).toBe(2)
  })

  it('retries only tracks that need it', async () => {
    const cookie = await signIn()
    const { id } = await createAndStart(cookie)
    const retry = (lang: string) => fetch(`${http}/sessions/${id}/tracks/${lang}/retry`, { method: 'POST', headers: { cookie } })
    expect((await retry('sk')).status).toBe(409) // healthy
    expect((await retry('xx')).status).toBe(409)

    engine.failOpens = 99
    engine.latest('sk').emitClose('error')
    await until(() => expect(manager.get(id)!.stats().tracks[0]!.state).toBe('error'))
    engine.failOpens = 0
    expect((await retry('sk')).status).toBe(204)
    await until(() => expect(manager.get(id)!.stats().tracks[0]!.state).toBe('live'))
  })
})

// ---- the media relay ----

describe('WebSocket relay', () => {
  it('carries host audio to the engine and translated audio plus captions to listeners', async () => {
    const cookie = await signIn()
    const { id, joinCode } = await createAndStart(cookie)

    const host = await connect(`${ws}/ws/host/${id}`, { cookie })
    const sk = await connect(`${ws}/ws/listen/${joinCode}?lang=sk`)
    const de = await connect(`${ws}/ws/listen/${joinCode.toLowerCase()}?lang=de`)
    await until(() => expect(manager.get(id)!.stats().listeners).toBe(2))

    // host mic -> every language stream
    host.ws.send(loudChunk())
    await until(() => {
      expect(engine.latest('sk').pushed).toHaveLength(1)
      expect(engine.latest('de').pushed).toHaveLength(1)
    })
    expect(engine.latest('sk').pushed[0]!.equals(loudChunk())).toBe(true)

    // translated audio -> only that language's listeners
    const audio = Buffer.from([10, 20, 30, 40])
    engine.latest('sk').emitAudio(audio)
    await until(() => expect(sk.binary).toHaveLength(1))
    expect(sk.binary[0]!.equals(audio)).toBe(true)
    expect(de.binary).toHaveLength(0)

    // captions -> listeners (both languages) and host
    engine.latest('sk').emitTranscript({ kind: 'source', text: 'Hello' })
    engine.latest('sk').emitTranscript({ kind: 'target', text: 'Ahoj' })
    engine.latest('de').emitTranscript({ kind: 'target', text: 'Hallo' })
    await until(() => {
      expect(sk.json.at(-1)).toEqual({ type: 'caption', original: 'Hello', translated: 'Ahoj' })
      expect(de.json.at(-1)).toEqual({ type: 'caption', original: 'Hello', translated: 'Hallo' })
      expect(host.json.at(-1)).toEqual({ type: 'caption', original: 'Hello', translated: { sk: 'Ahoj', de: 'Hallo' } })
    })
    expect(sk.json.some((m) => m.type === 'speaker' && m.speaking === true)).toBe(true)
  })

  it('lets a listener switch language over the socket', async () => {
    const cookie = await signIn()
    const { id, joinCode } = await createAndStart(cookie)
    const l = await connect(`${ws}/ws/listen/${joinCode}?lang=sk`)
    await until(() => expect(manager.get(id)!.stats().listeners).toBe(1))

    l.ws.send(JSON.stringify({ type: 'lang', lang: 'de' }))
    await until(() => expect(manager.get(id)!.stats().tracks.map((t) => t.listeners)).toEqual([0, 1]))

    engine.latest('de').emitAudio(Buffer.from([1]))
    await until(() => expect(l.binary).toHaveLength(1))

    l.ws.send('not json') // ignored, doesn't kill the socket
    l.ws.send(JSON.stringify({ type: 'lang', lang: 'nope' }))
    engine.latest('de').emitAudio(Buffer.from([2]))
    await until(() => expect(l.binary).toHaveLength(2))
  })

  it('stops counting a listener who leaves', async () => {
    const cookie = await signIn()
    const { id, joinCode } = await createAndStart(cookie)
    const l = await connect(`${ws}/ws/listen/${joinCode}?lang=sk`)
    await until(() => expect(manager.get(id)!.stats().listeners).toBe(1))
    l.ws.close()
    await until(() => expect(manager.get(id)!.stats().listeners).toBe(0))
  })

  it('tells listeners the session ended and closes their sockets', async () => {
    const cookie = await signIn()
    const { id, joinCode } = await createAndStart(cookie)
    const l = await connect(`${ws}/ws/listen/${joinCode}?lang=sk`)
    const host = await connect(`${ws}/ws/host/${id}`, { cookie })
    await until(() => expect(manager.get(id)!.stats().listeners).toBe(1))

    await fetch(`${http}/sessions/${id}/end`, { method: 'POST', headers: { cookie } })

    expect(await l.closed).toBe(1000)
    expect(await host.closed).toBe(1000)
    expect(l.json.some((m) => m.type === 'ended')).toBe(true)
  })

  it('tells listeners when their language track is down', async () => {
    const cookie = await signIn()
    const { joinCode } = await createAndStart(cookie)
    const l = await connect(`${ws}/ws/listen/${joinCode}?lang=sk`)
    await until(() => expect(l.json.some((m) => m.type === 'status')).toBe(true))

    engine.failOpens = 99
    engine.latest('sk').emitClose('error')
    await until(() => expect(l.json.at(-1)).toEqual({ type: 'status', trackDown: true }))
  })

  it('rejects unauthorised hosts, unknown sessions, languages and codes', async () => {
    const cookie = await signIn()
    const { id, joinCode } = await createAndStart(cookie)

    expect(await (await connect(`${ws}/ws/host/${id}`)).closed).toBe(4401) // no cookie
    expect(await (await connect(`${ws}/ws/host/${id}`, { cookie: 'ads_session=forged.sig' })).closed).toBe(4401)
    expect(await (await connect(`${ws}/ws/host/nope`, { cookie })).closed).toBe(4404)
    expect(await (await connect(`${ws}/ws/listen/ZZZZZZ?lang=sk`)).closed).toBe(4404)
    expect(await (await connect(`${ws}/ws/listen/${joinCode}?lang=xx`)).closed).toBe(4400)
    expect(await (await connect(`${ws}/ws/listen/${joinCode}`)).closed).toBe(4400) // no language
  })

  it('keeps the session through a host reconnect and replaces the old host socket', async () => {
    const cookie = await signIn()
    const { id } = await createAndStart(cookie)
    const first = await connect(`${ws}/ws/host/${id}`, { cookie })
    await until(() => expect(manager.get(id)!.hasHost).toBe(true))
    const second = await connect(`${ws}/ws/host/${id}`, { cookie })
    expect(await first.closed).toBe(4000)
    second.ws.send(loudChunk())
    await until(() => expect(engine.latest('sk').pushed).toHaveLength(1))
    expect(manager.get(id)!.hasHost).toBe(true)
  })

  it('ignores text frames from the host', async () => {
    const cookie = await signIn()
    const { id } = await createAndStart(cookie)
    const host = await connect(`${ws}/ws/host/${id}`, { cookie })
    host.ws.send('{"type":"hello"}')
    host.ws.send(loudChunk())
    await until(() => expect(engine.latest('sk').pushed).toHaveLength(1))
  })
})
