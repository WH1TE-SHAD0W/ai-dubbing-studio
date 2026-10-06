/** 100 ms of PCM16 mono at 16 kHz: the chunk size Gemini's docs recommend. */
export const CHUNK_BYTES = 3200

/** Re-slices an arbitrary byte stream into fixed CHUNK_BYTES chunks. */
export class Chunker {
  private rest: Buffer = Buffer.alloc(0)

  push(data: Buffer): Buffer[] {
    const buf = this.rest.length ? Buffer.concat([this.rest, data]) : data
    const out: Buffer[] = []
    let i = 0
    for (; i + CHUNK_BYTES <= buf.length; i += CHUNK_BYTES) out.push(buf.subarray(i, i + CHUNK_BYTES))
    this.rest = Buffer.from(buf.subarray(i)) // copy: don't pin the caller's buffer
    return out
  }
}

/** Loudness of a PCM16 LE chunk, 0..1. */
export function rms(pcm16: Buffer): number {
  const n = pcm16.length >> 1
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const s = pcm16.readInt16LE(i * 2) / 32768
    sum += s * s
  }
  return Math.sqrt(sum / n)
}
