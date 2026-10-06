import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Config } from './config.js'

// Single hardcoded host account, no database. The cookie is a signed expiry timestamp: enough to
// gate paid Gemini usage and host-only endpoints, nothing more.

export const COOKIE = 'ads_session'
const TTL_MS = 12 * 60 * 60 * 1000

/** Constant-time string compare (hashing first hides length differences too). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

export function createAuth(
  cfg: Pick<Config, 'hostEmail' | 'hostPassword' | 'sessionSecret'>,
  now: () => number = Date.now,
) {
  const sign = (payload: string) => createHmac('sha256', cfg.sessionSecret).update(payload).digest('base64url')

  return {
    ttlSeconds: TTL_MS / 1000,

    checkCredentials(email: string, password: string): boolean {
      // Evaluate both so timing doesn't reveal which one was wrong.
      const okEmail = safeEqual(email.trim().toLowerCase(), cfg.hostEmail.toLowerCase())
      const okPassword = safeEqual(password, cfg.hostPassword)
      return okEmail && okPassword
    },

    issue(): string {
      const payload = String(now() + TTL_MS)
      return `${payload}.${sign(payload)}`
    },

    verify(token: string | undefined): boolean {
      if (!token) return false
      const [payload, sig] = token.split('.')
      if (!payload || !sig || !safeEqual(sig, sign(payload))) return false
      return Number(payload) > now()
    },
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return undefined
}

export function setCookieHeader(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
}

/** Fixed-window limiter. Returns true while the key is under its limit. */
export function createRateLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { count: number; resetAt: number }>()
  return (key: string): boolean => {
    const t = now()
    if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k)
    const entry = hits.get(key)
    if (!entry || entry.resetAt <= t) {
      hits.set(key, { count: 1, resetAt: t + windowMs })
      return true
    }
    entry.count++
    return entry.count <= max
  }
}
