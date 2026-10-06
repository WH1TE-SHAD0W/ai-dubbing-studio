import { randomBytes, randomInt } from 'node:crypto'
import type { Config } from '../config.js'
import type { DubbingEngine } from '../engine/types.js'
import { Session, type SessionDeps } from './session.js'

// No I, L, O, 0, 1: easy to misread when a code is read out loud or off a projector.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 6
const DRAFT_TTL_MS = 30 * 60 * 1000
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

export class ValidationError extends Error {}

export interface CreateInput {
  title: string
  sourceLang: string
  targetLangs: string[]
}

export type ManagerConfig = Pick<Config, 'maxSessionMinutes' | 'hostGraceMs' | 'maxTargets' | 'hostName'>

export function generateCode(): string {
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** In-memory sessions. One backend instance only: nothing here survives a restart. */
export class SessionManager {
  private readonly byId = new Map<string, Session>()
  private readonly byCode = new Map<string, Session>()
  private readonly now: () => number
  private readonly sessionDeps: SessionDeps

  constructor(
    private readonly cfg: ManagerConfig,
    engine: DubbingEngine,
    opts: Pick<SessionDeps, 'now' | 'track' | 'log'> = {},
  ) {
    this.now = opts.now ?? Date.now
    this.sessionDeps = { engine, ...opts, onEnded: (s) => this.forget(s) }
  }

  create(input: CreateInput): Session {
    const title = input.title.trim()
    if (!title || title.length > 120) throw new ValidationError('Title must be 1–120 characters.')
    if (!LANG.test(input.sourceLang)) throw new ValidationError('Invalid spoken language.')

    const targets = [...new Set(input.targetLangs)]
    if (targets.length === 0) throw new ValidationError('Pick at least one target language.')
    if (targets.length > this.cfg.maxTargets)
      throw new ValidationError(`At most ${this.cfg.maxTargets} target languages.`)
    if (targets.some((l) => !LANG.test(l))) throw new ValidationError('Invalid target language.')
    if (targets.includes(input.sourceLang))
      throw new ValidationError('The spoken language can’t also be a target.')

    let code = generateCode()
    while (this.byCode.has(code)) code = generateCode()

    const session = new Session(
      {
        id: randomBytes(9).toString('base64url'),
        joinCode: code,
        title,
        sourceLang: input.sourceLang,
        targetLangs: targets,
        hostName: this.cfg.hostName,
      },
      this.sessionDeps,
    )
    this.byId.set(session.id, session)
    this.byCode.set(code, session)
    return session
  }

  get(id: string): Session | undefined {
    return this.byId.get(id)
  }

  /** Only live sessions can be joined. */
  getLiveByCode(code: string): Session | undefined {
    const s = this.byCode.get(normalizeCode(code))
    return s?.status === 'live' ? s : undefined
  }

  endAll(reason = 'shutdown'): void {
    for (const s of [...this.byId.values()]) s.end(reason)
  }

  /**
   * Cost and hygiene guard: end live sessions whose host has been gone too long or that ran past
   * the maximum duration (so a forgotten tab can't keep paying for Gemini streams), and drop
   * sessions that were created but never started.
   */
  reap(): void {
    const t = this.now()
    for (const s of [...this.byId.values()]) {
      if (s.status === 'live') {
        if (s.hostGoneAt !== null && t - s.hostGoneAt > this.cfg.hostGraceMs) s.end('host-gone')
        else if (s.startedAt !== null && t - s.startedAt > this.cfg.maxSessionMinutes * 60_000) s.end('max-duration')
      } else if (s.status === 'draft' && t - s.createdAt > DRAFT_TTL_MS) {
        this.forget(s)
      }
    }
  }

  startReaper(intervalMs = 5000): () => void {
    const timer = setInterval(() => this.reap(), intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  private forget(s: Session): void {
    this.byId.delete(s.id)
    if (this.byCode.get(s.joinCode) === s) this.byCode.delete(s.joinCode)
  }
}
