// Pure audio helpers for the live media layer. No browser APIs, so they are unit-testable.
//
// Wire formats (see backend/src/ws): host -> server is PCM16 LE mono 16 kHz in 100 ms frames;
// server -> listener is PCM16 LE mono 24 kHz.

export const HOST_RATE = 16000
export const LISTEN_RATE = 24000
/** 100 ms of 16 kHz audio: the chunk size the engine recommends. */
export const FRAME_SAMPLES = 1600

/** Float32 [-1, 1] -> PCM16, clamped. */
export function floatToInt16(input: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

/** PCM16 LE bytes -> Float32 [-1, 1]. An odd trailing byte is ignored. */
export function int16BytesToFloat(buf: ArrayBuffer): Float32Array<ArrayBuffer> {
  const samples = new Int16Array(buf, 0, buf.byteLength >> 1)
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 0x8000
  return out
}

/**
 * Streaming downsampler: averages the input samples that fall into each output sample (a box
 * filter, which also tames aliasing for speech). Keeps state between calls, so blocks of any size
 * can be fed in order.
 */
export class Downsampler {
  private pos = 0
  private acc = 0
  private count = 0
  private readonly ratio: number

  constructor(inRate: number, outRate = HOST_RATE) {
    this.ratio = inRate / outRate
  }

  process(input: Float32Array): Float32Array<ArrayBuffer> {
    const out: number[] = []
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i]
      this.count++
      this.pos++
      if (this.pos >= this.ratio) {
        out.push(this.acc / this.count)
        this.acc = 0
        this.count = 0
        this.pos -= this.ratio
      }
    }
    return Float32Array.from(out)
  }
}

/** Collects samples and hands back exact fixed-size frames. */
export class Framer {
  private rest: Int16Array<ArrayBuffer> = new Int16Array(0)

  constructor(private readonly frameSamples = FRAME_SAMPLES) {}

  push(samples: Int16Array): Int16Array<ArrayBuffer>[] {
    const all = new Int16Array(this.rest.length + samples.length)
    all.set(this.rest)
    all.set(samples, this.rest.length)
    const frames: Int16Array<ArrayBuffer>[] = []
    let i = 0
    for (; i + this.frameSamples <= all.length; i += this.frameSamples) frames.push(all.slice(i, i + this.frameSamples))
    this.rest = all.slice(i)
    return frames
  }
}

export interface Placement {
  /** AudioContext time to start this chunk. */
  start: number
  /** Playback speed; slightly above 1 while catching up. */
  rate: number
}

/**
 * Decides when each incoming chunk plays, so listeners hear smooth audio but never drift far
 * behind the speaker. Translated audio can arrive in bursts. A small lead absorbs jitter; if the
 * queue grows past `catchUpAfter` it plays slightly faster, and only as a last resort drops audio.
 */
export class PlaybackScheduler {
  private next = 0

  constructor(
    private readonly lead = 0.12,
    private readonly catchUpAfter = 1.0,
    private readonly fastAfter = 2.5,
    private readonly dropAfter = 6,
  ) {}

  place(now: number, duration: number): Placement | null {
    if (this.next < now + 0.02) this.next = now + this.lead // first chunk, or we ran dry: re-prime the jitter buffer
    const ahead = this.next - now
    if (ahead > this.dropAfter) return null
    const rate = ahead > this.fastAfter ? 1.25 : ahead > this.catchUpAfter ? 1.1 : 1
    const start = this.next
    this.next += duration / rate
    return { start, rate }
  }

  reset(): void {
    this.next = 0
  }
}
