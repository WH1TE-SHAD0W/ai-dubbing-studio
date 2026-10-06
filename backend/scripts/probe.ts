// Live check against the real Gemini Live Translate API. Costs a little: it streams a short WAV.
//
//   GEMINI_API_KEY=... npx tsx scripts/probe.ts speech-16k-mono.wav [targetLang]
//
// The WAV must be PCM16, mono, 16 kHz. It reports what the docs don't say: how transcript
// fragments arrive, time to first translated audio, and whether the session stays healthy.
import { readFileSync, writeFileSync } from 'node:fs'
import { CHUNK_BYTES } from '../src/audio.js'
import { GeminiEngine } from '../src/engine/gemini.js'

const [wavPath, targetLang = 'sk'] = process.argv.slice(2)
const apiKey = process.env.GEMINI_API_KEY
const model = process.env.GEMINI_MODEL || 'gemini-3.5-live-translate-preview'
if (!wavPath || !apiKey) {
  console.error('usage: GEMINI_API_KEY=... tsx scripts/probe.ts <16k-mono-pcm16.wav> [targetLang]')
  process.exit(2)
}

function readWav(path: string): Buffer {
  const b = readFileSync(path)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file')
  let fmt: { channels: number; rate: number; bits: number } | undefined
  for (let i = 12; i + 8 <= b.length; ) {
    const id = b.toString('ascii', i, i + 4)
    const size = b.readUInt32LE(i + 4)
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(i + 10), rate: b.readUInt32LE(i + 12), bits: b.readUInt16LE(i + 22) }
    if (id === 'data') {
      if (!fmt || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16)
        throw new Error(`need PCM16 mono 16 kHz, got ${JSON.stringify(fmt)}`)
      return b.subarray(i + 8, i + 8 + size)
    }
    i += 8 + size + (size % 2)
  }
  throw new Error('no data chunk')
}

function writeWav(path: string, pcm: Buffer, rate: number) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  writeFileSync(path, Buffer.concat([h, pcm]))
}

const pcm = readWav(wavPath)
const seconds = pcm.length / 32000
console.log(`input: ${seconds.toFixed(1)} s, target=${targetLang}, model=${model}`)

const engine = new GeminiEngine(apiKey, model, { warn: (o, m) => console.warn('warn:', m, o) })
const t0 = Date.now()
let stream
try {
  stream = await engine.open({ targetLang })
} catch (err) {
  console.error(`could not connect after ${Date.now() - t0} ms: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
console.log(`connected in ${Date.now() - t0} ms`)

const out: Buffer[] = []
let firstAudioAt: number | null = null
let sentAt = Date.now()
let events = 0
stream.onAudio((b) => {
  firstAudioAt ??= Date.now()
  out.push(b)
})
stream.onTranscript((t) => {
  if (events++ < 40) console.log(`  +${Date.now() - sentAt} ms  ${t.kind.padEnd(6)} finished=${t.finished ?? '-'}  ${JSON.stringify(t.text)}`)
})
let closed: string | undefined
stream.onClose((r) => (closed = r))

// Stream in real time, 100 ms at a time, then trailing silence so the model can finish.
sentAt = Date.now()
const silence = Buffer.alloc(CHUNK_BYTES * 30)
const all = Buffer.concat([pcm, silence])
for (let i = 0; i < all.length; i += CHUNK_BYTES) {
  stream.pushAudio(all.subarray(i, i + CHUNK_BYTES))
  await new Promise((r) => setTimeout(r, 100))
  if (closed) break
}
await new Promise((r) => setTimeout(r, 3000))

const audio = Buffer.concat(out)
console.log('---')
console.log(`first translated audio: ${firstAudioAt ? firstAudioAt - sentAt : 'never'} ms after the first chunk`)
console.log(`translated audio: ${out.length} chunks, ${audio.length} bytes = ${(audio.length / 48000).toFixed(1)} s @ 24 kHz`)
console.log(`transcript events: ${events} (first 40 shown above)`)
console.log(`resume handle offered: ${stream.resumeHandle() ? 'yes' : 'no'}`)
console.log(`stream closed by server: ${closed ?? 'no'}`)
if (audio.length) {
  const file = `probe-out-${targetLang}.wav`
  writeWav(file, audio, 24000)
  console.log(`wrote ${file}`)
}
stream.close()
process.exit(audio.length ? 0 : 1)
