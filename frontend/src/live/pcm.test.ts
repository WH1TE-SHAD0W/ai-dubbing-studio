import { describe, expect, it } from 'vitest'
import { Downsampler, FRAME_SAMPLES, Framer, PlaybackScheduler, floatToInt16, int16BytesToFloat } from './pcm'

describe('PCM conversion', () => {
  it('converts float to PCM16 with clamping', () => {
    const out = floatToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5]))
    expect([...out]).toEqual([0, 32767, -32768, 32767, -32768, 16383])
  })

  it('round-trips through PCM16 bytes within quantisation error', () => {
    const input = Float32Array.from([0, 0.25, -0.5, 0.999, -1])
    const bytes = floatToInt16(input).buffer
    const back = int16BytesToFloat(bytes)
    input.forEach((v, i) => expect(back[i]).toBeCloseTo(v, 3))
  })

  it('reads little-endian bytes and ignores a trailing odd byte', () => {
    const bytes = new Uint8Array([0x00, 0x40, 0xff, 0xff, 0x7f]).buffer // 16384, -1, then a stray byte
    const out = int16BytesToFloat(bytes)
    expect(out).toHaveLength(2)
    expect(out[0]).toBeCloseTo(0.5, 5)
    expect(out[1]).toBeCloseTo(-1 / 32768, 5)
  })
})

describe('Downsampler', () => {
  it('turns 48 kHz into 16 kHz by averaging', () => {
    const d = new Downsampler(48000, 16000)
    const out = d.process(Float32Array.from([1, 1, 1, 0, 0, 0, 3, 3, 3]))
    expect([...out]).toEqual([1, 0, 3])
  })

  it('gives the same result however the input is chunked', () => {
    const signal = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 20))
    const whole = new Downsampler(48000).process(signal)

    const parts = new Downsampler(48000)
    const pieces = [signal.subarray(0, 7), signal.subarray(7, 2000), signal.subarray(2000)].map((p) => parts.process(p))
    const joined = Float32Array.from(pieces.flatMap((p) => [...p]))

    expect(joined).toHaveLength(whole.length)
    joined.forEach((v, i) => expect(v).toBeCloseTo(whole[i], 6))
  })

  it('produces about 16000 samples from one second of 44.1 kHz input', () => {
    const out = new Downsampler(44100).process(new Float32Array(44100))
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(1)
  })

  it('passes 16 kHz through unchanged', () => {
    const input = Float32Array.from([0.1, 0.2, 0.3])
    expect([...new Downsampler(16000).process(input)]).toEqual([...input])
  })
})

describe('Framer', () => {
  it('emits exact 100 ms frames and keeps the remainder', () => {
    const f = new Framer()
    expect(f.push(new Int16Array(1000))).toHaveLength(0)
    const frames = f.push(new Int16Array(FRAME_SAMPLES * 2))
    expect(frames).toHaveLength(2)
    expect(frames.every((fr) => fr.length === FRAME_SAMPLES && fr.byteLength === 3200)).toBe(true)
    expect(f.push(new Int16Array(FRAME_SAMPLES - 1000 - 1))).toHaveLength(0) // 1000 left over + this = 1 short
    expect(f.push(new Int16Array(1))).toHaveLength(1)
  })

  it('keeps sample order across frames', () => {
    const f = new Framer(4)
    const frames = f.push(Int16Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))
    expect(frames.map((fr) => [...fr])).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ])
    expect(f.push(Int16Array.from([10, 11, 12])).map((fr) => [...fr])).toEqual([[9, 10, 11, 12]])
  })
})

describe('PlaybackScheduler', () => {
  it('starts the first chunk after a small jitter buffer and plays chunks back to back', () => {
    const s = new PlaybackScheduler(0.12)
    expect(s.place(10, 0.2)).toEqual({ start: 10.12, rate: 1 })
    const second = s.place(10.01, 0.2)!
    expect(second.start).toBeCloseTo(10.32, 5)
    expect(second.rate).toBe(1)
  })

  it('re-primes after running dry instead of scheduling in the past', () => {
    const s = new PlaybackScheduler(0.12)
    s.place(10, 0.2)
    expect(s.place(20, 0.2)).toEqual({ start: 20.12, rate: 1 })
  })

  it('speeds up playback when audio piles up, so lag cannot grow without bound', () => {
    const s = new PlaybackScheduler(0.12)
    s.place(0, 1.5) // queued 1.62 s ahead
    expect(s.place(0, 0.5)!.rate).toBe(1.1)

    const fast = new PlaybackScheduler(0.12)
    fast.place(0, 4) // 4.12 s ahead
    expect(fast.place(0, 0.5)!.rate).toBe(1.25)
  })

  it('drops audio only as a last resort', () => {
    const s = new PlaybackScheduler(0.12)
    s.place(0, 10)
    expect(s.place(0, 0.5)).toBeNull()
  })

  it('forgets its queue on reset (language switch)', () => {
    const s = new PlaybackScheduler(0.12)
    s.place(0, 10)
    s.reset()
    expect(s.place(0, 0.5)).toEqual({ start: 0.12, rate: 1 })
  })
})
