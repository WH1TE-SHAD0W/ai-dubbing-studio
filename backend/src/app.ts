import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import { COOKIE, createAuth, createRateLimiter, readCookie, setCookieHeader } from './auth.js'
import type { Config } from './config.js'
import type { DubbingEngine } from './engine/types.js'
import { SessionManager, ValidationError, normalizeCode } from './session/manager.js'
import type { SessionDeps } from './session/session.js'
import type { Conn } from './session/track.js'

export interface AppDeps {
  config: Config
  engine: DubbingEngine
  /** Test hooks. */
  now?: () => number
  track?: SessionDeps['track']
  logger?: boolean | { level: string }
}

export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; manager: SessionManager }> {
  const { config } = deps
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true }) // only reachable through nginx
  const auth = createAuth(config, deps.now)
  const manager = new SessionManager(config, deps.engine, { now: deps.now, track: deps.track, log: app.log })

  const signinLimit = createRateLimiter(5, 60_000, deps.now)
  const joinLimit = createRateLimiter(30, 60_000, deps.now)
  const wsLimit = createRateLimiter(60, 60_000, deps.now)

  await app.register(websocket, { options: { maxPayload: 64 * 1024 } })

  // Fastify rejects `Content-Type: application/json` with an empty body, which is what a bodyless
  // POST (start, end, retry) looks like from many clients. Treat an empty body as "no body".
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, undefined)
    try {
      done(null, JSON.parse(body as string))
    } catch {
      done(Object.assign(new Error('Invalid JSON.'), { statusCode: 400 }), undefined)
    }
  })

  const isHost = (req: FastifyRequest) => auth.verify(readCookie(req.headers.cookie, COOKIE))
  const requireHost = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isHost(req)) return reply.code(401).send({ message: 'Sign in required.' })
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ValidationError) return reply.code(400).send({ message: err.message })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) app.log.error(err)
    return reply.code(status).send({ message: status >= 500 ? 'Internal error.' : (err as Error).message })
  })

  app.get('/healthz', async () => 'ok')

  // ---- auth ----

  app.post('/auth/signin', async (req, reply) => {
    if (!signinLimit(req.ip)) return reply.code(429).send({ message: 'Too many attempts. Wait a minute and try again.' })
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown }
    if (typeof body.email !== 'string' || typeof body.password !== 'string' || !auth.checkCredentials(body.email, body.password))
      return reply.code(401).send({ message: 'Email or password is incorrect.' })
    const secure = req.headers['x-forwarded-proto'] === 'https'
    reply.header('Set-Cookie', setCookieHeader(auth.issue(), auth.ttlSeconds, secure))
    return { name: config.hostName }
  })

  app.post('/auth/signout', async (_req, reply) => {
    reply.header('Set-Cookie', setCookieHeader('', 0, false))
    return reply.code(204).send()
  })

  // ---- sessions (host only) ----

  app.post('/sessions', { preHandler: requireHost }, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const consent = (b.consent ?? {}) as Record<string, unknown>
    if (consent.speaker !== true || consent.aiNotice !== true || typeof consent.textVersion !== 'string')
      throw new ValidationError('Speaker consent and the AI-audio notice are required.')
    if (typeof b.title !== 'string' || typeof b.sourceLang !== 'string' || !Array.isArray(b.targetLangs) || !b.targetLangs.every((l) => typeof l === 'string'))
      throw new ValidationError('Invalid session.')

    const session = manager.create({ title: b.title, sourceLang: b.sourceLang, targetLangs: b.targetLangs as string[] })
    // The consent record is a log line only: no database, no audio, no transcripts.
    app.log.info({ event: 'consent', sessionId: session.id, textVersion: consent.textVersion, at: new Date().toISOString() })
    return { id: session.id, joinCode: session.joinCode }
  })

  app.post<{ Params: { id: string } }>('/sessions/:id/start', { preHandler: requireHost }, async (req, reply) => {
    const s = manager.get(req.params.id)
    if (!s || s.status === 'ended') return reply.code(404).send({ message: 'Session not found.' })
    s.start()
    return { id: s.id, title: s.title, joinCode: s.joinCode, sourceLang: s.sourceLang, startedAt: s.startedAt }
  })

  app.post<{ Params: { id: string } }>('/sessions/:id/end', { preHandler: requireHost }, async (req, reply) => {
    manager.get(req.params.id)?.end('host-ended') // idempotent: ending a gone session is fine
    return reply.code(204).send()
  })

  app.post<{ Params: { id: string; lang: string } }>(
    '/sessions/:id/tracks/:lang/retry',
    { preHandler: requireHost },
    async (req, reply) => {
      const ok = manager.get(req.params.id)?.retryTrack(req.params.lang)
      return reply.code(ok ? 204 : 409).send(ok ? undefined : { message: 'That track can’t be retried right now.' })
    },
  )

  // Diagnostics: what the host sent, what each Gemini stream got and returned. Counts and timings only.
  app.get<{ Params: { id: string } }>('/sessions/:id/debug', { preHandler: requireHost }, async (req, reply) => {
    const s = manager.get(req.params.id)
    if (!s) return reply.code(404).send({ message: 'Session not found.' })
    return s.debugSnapshot()
  })

  // Live stats for the control room (Server-Sent Events).
  app.get<{ Params: { id: string } }>('/sessions/:id/stats', { preHandler: requireHost }, (req, reply) => {
    const s = manager.get(req.params.id)
    if (!s) return reply.code(404).send({ message: 'Session not found.' })
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const send = () => {
      if (s.status === 'ended') return stop()
      raw.write(`data: ${JSON.stringify(s.stats())}\n\n`)
    }
    const timer = setInterval(send, 1000)
    const stop = () => {
      clearInterval(timer)
      raw.end()
    }
    req.raw.on('close', () => clearInterval(timer))
    send()
  })

  // ---- listeners (public) ----

  app.get<{ Params: { code: string } }>('/join/:code', async (req, reply) => {
    if (!joinLimit(req.ip)) return reply.code(429).send({ message: 'Too many attempts. Wait a minute and try again.' })
    const s = manager.getLiveByCode(req.params.code)
    if (!s) return reply.code(404).send({ message: 'No live session has that code.' })
    return { title: s.title, speakerName: s.hostName, sourceLang: s.sourceLang, languages: s.targetLangs }
  })

  // ---- WebSockets ----

  // Host mic in: binary PCM16 LE mono 16 kHz. Captions come back as JSON.
  app.get<{ Params: { id: string } }>('/ws/host/:id', { websocket: true }, (socket, req) => {
    if (!isHost(req)) return socket.close(4401, 'unauthorised')
    const s = manager.get(req.params.id)
    if (!s || s.status !== 'live') return socket.close(4404, 'not live')

    const conn = toConn(socket)
    keepAlive(socket)
    s.setHost(conn)
    socket.on('message', (data, isBinary) => {
      if (isBinary) s.pushHostAudio(data as Buffer)
    })
    socket.on('close', () => s.hostLeft(conn))
  })

  // Listener: translated PCM16 LE mono 24 kHz out as binary, captions and state as JSON.
  app.get<{ Params: { code: string }; Querystring: { lang?: string } }>(
    '/ws/listen/:code',
    { websocket: true },
    (socket, req) => {
      if (!wsLimit(req.ip)) return socket.close(4429, 'rate limited')
      const s = manager.getLiveByCode(normalizeCode(req.params.code))
      if (!s) return socket.close(4404, 'not live')

      const conn = toConn(socket)
      const result = s.addListener(req.query.lang ?? '', conn)
      if (result === 'not-live') return socket.close(4404, 'not live')
      if (result === 'no-lang') return socket.close(4400, 'unknown language')

      keepAlive(socket)
      socket.on('message', (data, isBinary) => {
        if (isBinary) return
        try {
          const msg = JSON.parse(data.toString()) as { type?: string; lang?: unknown }
          if (msg.type === 'lang' && typeof msg.lang === 'string') s.moveListener(conn, msg.lang)
        } catch {
          /* ignore malformed control messages */
        }
      })
      socket.on('close', () => s.removeListener(conn))
    },
  )

  return { app, manager }
}

function toConn(ws: WebSocket): Conn {
  return {
    sendBinary: (b) => ws.readyState === ws.OPEN && ws.send(b, { binary: true }),
    sendJson: (o) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o)),
    bufferedAmount: () => ws.bufferedAmount,
    close: (code, reason) => ws.close(code, reason),
  }
}

/** Ping so idle connections survive proxies, and drop sockets that stop answering. */
function keepAlive(ws: WebSocket, intervalMs = 25_000): void {
  let alive = true
  ws.on('pong', () => (alive = true))
  const timer = setInterval(() => {
    if (!alive) return ws.terminate()
    alive = false
    ws.ping()
  }, intervalMs)
  timer.unref?.()
  ws.on('close', () => clearInterval(timer))
}
