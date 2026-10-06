import { describe, expect, it } from 'vitest'
import { formatJoinCode, isCompleteJoinCode, normalizeJoinCode } from './joinCode'
import { MAX_TARGETS, toggleTarget, visibleTargets, withoutSpoken } from './languages'
import { canStart, startBlockers, type SessionForm } from './sessionForm'
import { formatDuration, formatElapsed, formatLatency, latencyFill, latencyLevel } from './time'

describe('join code', () => {
  it('normalises case, separators and length', () => {
    expect(normalizeJoinCode('kx7-4m2')).toBe('KX74M2')
    expect(normalizeJoinCode(' kx7 4m2 extra')).toBe('KX74M2')
  })
  it('formats with a hyphen after three characters', () => {
    expect(formatJoinCode('kx')).toBe('KX')
    expect(formatJoinCode('kx74')).toBe('KX7-4')
    expect(formatJoinCode('KX74M2')).toBe('KX7-4M2')
  })
  it('knows when a code is complete', () => {
    expect(isCompleteJoinCode('KX7-4M2')).toBe(true)
    expect(isCompleteJoinCode('KX7-4M')).toBe(false)
  })
})

describe('time formatting', () => {
  it('formats elapsed time as HH:MM:SS', () => {
    expect(formatElapsed((42 * 60 + 17) * 1000)).toBe('00:42:17')
    expect(formatElapsed(3_723_000)).toBe('01:02:03')
    expect(formatElapsed(-5)).toBe('00:00:00')
  })
  it('formats sample durations', () => {
    expect(formatDuration(30.9)).toBe('0:30')
    expect(formatDuration(65)).toBe('1:05')
  })
  it('labels latency', () => {
    expect(formatLatency(1400)).toBe('1.4 s')
    expect(latencyLevel(1400)).toBe('good')
    expect(latencyLevel(2200)).toBe('fair')
    expect(latencyLevel(5000)).toBe('slow')
    expect(latencyFill(99999)).toBe(1)
  })
})

describe('target languages', () => {
  it('toggles on and off', () => {
    expect(toggleTarget(['sk'], 'de')).toEqual(['sk', 'de'])
    expect(toggleTarget(['sk', 'de'], 'sk')).toEqual(['de'])
  })
  it(`never exceeds ${MAX_TARGETS}`, () => {
    const full = ['sk', 'de', 'es', 'fr', 'uk']
    expect(toggleTarget(full, 'pl')).toEqual(full)
    expect(toggleTarget(full, 'fr')).toHaveLength(MAX_TARGETS - 1)
  })
  it('drops the spoken language from targets and chips', () => {
    expect(withoutSpoken(['sk', 'de'], 'de')).toEqual(['sk'])
    expect(visibleTargets('de', [], false).map((l) => l.code)).not.toContain('de')
  })
  it('shows selected languages even when collapsed, and everything when expanded', () => {
    expect(visibleTargets('en', ['ro'], false).map((l) => l.code)).toContain('ro')
    expect(visibleTargets('en', [], false).map((l) => l.code)).not.toContain('ro')
    expect(visibleTargets('en', [], true).map((l) => l.code)).toContain('ro')
  })
  it('only offers languages Gemini Live Translate supports (Irish is not one of them)', () => {
    expect(visibleTargets('en', [], true).map((l) => l.code)).not.toContain('ga')
  })
})

describe('session form gating', () => {
  const ok: SessionForm = { title: 'Ethics 101', targets: ['sk'], speakerConsent: true, aiNotice: true }
  it('allows a complete form', () => {
    expect(canStart(ok)).toBe(true)
    expect(startBlockers(ok)).toEqual([])
  })
  it('requires both consent boxes', () => {
    expect(canStart({ ...ok, speakerConsent: false })).toBe(false)
    expect(canStart({ ...ok, aiNotice: false })).toBe(false)
  })
  it('requires a title and a target', () => {
    expect(canStart({ ...ok, title: '   ' })).toBe(false)
    expect(canStart({ ...ok, targets: [] })).toBe(false)
  })
  it('reports the first thing to fix first', () => {
    expect(startBlockers({ ...ok, title: '', speakerConsent: false })[0]).toMatch(/title/i)
  })
  it('no longer asks for a voice sample (the engine takes none)', () => {
    expect(startBlockers({ ...ok, targets: [] }).join(' ')).not.toMatch(/sample/i)
  })
})
