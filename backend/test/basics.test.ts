import { describe, expect, it } from 'vitest'
import { COOKIE, createAuth, createRateLimiter, readCookie, setCookieHeader } from '../src/auth.js'
import { CHUNK_BYTES, Chunker, rms } from '../src/audio.js'
import { loadConfig } from '../src/config.js'
import { RollingCaption } from '../src/session/caption.js'
import { generateCode, normalizeCode, CODE_LENGTH } from '../src/session/manager.js'
import { loudChunk, silentChunk } from './fakes.js'

describe('auth', () => {
  const cfg = { hostEmail: 'Host@Example.com', hostPassword: 'pw', sessionSecret: 's3cret' }

  it('checks credentials case-insensitively on email only', () => {
    const a = createAuth(cfg)
    expect(a.checkCredentials(' host@example.com ', 'pw')).toBe(true)
    expect(a.checkCredentials('host@example.com', 'PW')).toBe(false)
    expect(a.checkCredentials('other@example.com', 'pw')).toBe(false)
  })

  it('issues cookies that verify, expire, and reject tampering', () => {
    let t = 1_000_000
    const a = createAuth(cfg, () => t)
    const token = a.issue()
    expect(a.verify(token)).toBe(true)
    expect(a.verify(token + 'x')).toBe(false)
    expect(a.verify(`${Number(token.split('.')[0]) + 1}.${token.split('.')[1]}`)).toBe(false) // forged expiry
    expect(a.verify(undefined)).toBe(false)
    expect(a.verify('garbage')).toBe(false)
    t += 12 * 3600_000 + 1
    expect(a.verify(token)).toBe(false)
  })

  it('rejects a token signed with a different secret', () => {
    const token = createAuth({ ...cfg, sessionSecret: 'other' }).issue()
    expect(createAuth(cfg).verify(token)).toBe(false)
  })

  it('parses cookies and builds an httpOnly Set-Cookie', () => {
    expect(readCookie('a=1; ads_session=abc%2E1; b=2', COOKIE)).toBe('abc.1')
    expect(readCookie(undefined, COOKIE)).toBeUndefined()
    const h = setCookieHeader('v', 60, true)
    expect(h).toMatch(/HttpOnly/)
    expect(h).toMatch(/SameSite=Lax/)
    expect(h).toMatch(/Secure/)
    expect(setCookieHeader('v', 60, false)).not.toMatch(/Secure/)
  })

  it('rate-limits per key within a window', () => {
    let t = 0
    const allow = createRateLimiter(3, 1000, () => t)
    expect([1, 2, 3, 4].map(() => allow('ip'))).toEqual([true, true, true, false])
    expect(allow('other')).toBe(true)
    t = 1001
    expect(allow('ip')).toBe(true)
  })
})

describe('audio helpers', () => {
  it('re-slices arbitrary frames into 100 ms chunks and keeps the remainder', () => {
    const c = new Chunker()
    expect(c.push(Buffer.alloc(1000))).toHaveLength(0)
    const out = c.push(Buffer.alloc(CHUNK_BYTES * 2))
    expect(out).toHaveLength(2)
    expect(out.every((b) => b.length === CHUNK_BYTES)).toBe(true)
    // 1000 + 6400 = 7400 -> 2 chunks + 1000 left, so 2200 more completes the next one
    expect(c.push(Buffer.alloc(2199))).toHaveLength(0)
    expect(c.push(Buffer.alloc(1))).toHaveLength(1)
  })

  it('measures loudness', () => {
    expect(rms(silentChunk())).toBe(0)
    expect(rms(loudChunk())).toBeGreaterThan(0.2)
    expect(rms(Buffer.alloc(0))).toBe(0)
  })
})

describe('rolling caption', () => {
  it('accumulates fragments and starts a new segment after a finished one', () => {
    const c = new RollingCaption()
    expect(c.add('Hello', false, 0)).toBe('Hello')
    expect(c.add(' world', true, 100)).toBe('Hello world')
    expect(c.add('Next', false, 200)).toBe('Next')
  })
  it('starts fresh after a pause', () => {
    const c = new RollingCaption(240, 1000)
    c.add('old words', false, 0)
    expect(c.add('new', false, 5000)).toBe('new')
  })
  it('keeps only the most recent text, on a word boundary', () => {
    const c = new RollingCaption(20)
    const out = c.add('one two three four five six seven', false, 0)
    expect(out.length).toBeLessThanOrEqual(20)
    expect(out.endsWith('seven')).toBe(true)
    expect(out.startsWith(' ')).toBe(false)
  })
})

describe('join codes', () => {
  it('uses six characters from an unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(new RegExp(`^[A-HJKMNP-Z2-9]{${CODE_LENGTH}}$`))
  })
  it('normalises human input', () => {
    expect(normalizeCode('kx7-4m2 ')).toBe('KX74M2')
  })
})

describe('config', () => {
  const base = { GEMINI_API_KEY: 'k', HOST_EMAIL: 'a@b.c', HOST_PASSWORD: 'p' }
  it('applies defaults', () => {
    const c = loadConfig(base)
    expect(c.geminiModel).toBe('gemini-3.5-live-translate-preview')
    expect(c.maxTargets).toBe(5)
    expect(c.hostGraceMs).toBe(60_000)
    expect(c.sessionSecret.length).toBeGreaterThan(20)
  })
  it('refuses to start without the required secrets', () => {
    expect(() => loadConfig({ ...base, GEMINI_API_KEY: '' })).toThrow(/GEMINI_API_KEY/)
    expect(() => loadConfig({ ...base, HOST_PASSWORD: undefined })).toThrow(/HOST_PASSWORD/)
    expect(() => loadConfig({ ...base, MAX_SESSION_MINUTES: 'abc' })).toThrow(/MAX_SESSION_MINUTES/)
  })
})
