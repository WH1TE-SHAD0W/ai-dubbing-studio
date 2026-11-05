// Spike worker for ADR-0019: the idle state of a translator pod, written in Node.
//
// It does what a warm pod does while it waits for work (pod-spec §4.1 Idle):
//   - loads and initialises the real SDKs (LiveKit, Gemini, Redis, Prometheus),
//   - serves /healthz, /readyz and /metrics on HTTP_ADDR,
//   - blocks on XREADGROUP for a job.
//
// When a job arrives, runJob does the real job path: join both rooms, open Gemini Live,
// pipe the host's audio through it and publish the result. The live-track scenario sends
// one job; the idle scenario sends none. The Go worker does the same steps.
import { createServer } from 'node:http'
import { hostname } from 'node:os'
import { GoogleGenAI, Modality, type LiveServerMessage } from '@google/genai'
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from '@livekit/rtc-node'
import { Redis } from 'ioredis'
import { Counter, Gauge, collectDefaultMetrics, register } from 'prom-client'

const env = (key: string, def: string) => process.env[key] || def
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }))

const podName = env('POD_NAME', hostname())
const stream = env('JOB_STREAM', 'translate:jobs')
const group = env('JOB_GROUP', 'translators')

collectDefaultMetrics()
const busy = new Gauge({ name: 'translator_busy', help: '1 while the pod holds a job.' })
const samplesIn = new Counter({ name: 'translator_samples_in_total', help: 'Host audio samples sent to Gemini.' })
const samplesOut = new Counter({ name: 'translator_samples_out_total', help: 'Translated samples written to the out track.' })
let ready = false

// The SDK clients a real pod creates at start-up. Neither one connects anywhere yet.
// Idle runs pass no key; the client still needs one to be created.
const gem = new GoogleGenAI({ apiKey: env('GEMINI_API_KEY', 'unused-while-idle') })
void new Room()

const server = createServer(async (req, res) => {
  if (req.url === '/healthz') return res.writeHead(200).end()
  if (req.url === '/readyz') return res.writeHead(ready ? 200 : 503).end()
  if (req.url === '/metrics') {
    res.writeHead(200, { 'content-type': register.contentType })
    return res.end(await register.metrics())
  }
  res.writeHead(404).end()
})
const [, port = '8080'] = env('HTTP_ADDR', ':8080').split(':')
server.listen(Number(port))

const redis = new Redis(env('REDIS_URL', 'redis://redis:6379'), { lazyConnect: true })
await redis.connect()
try {
  await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM')
} catch (err) {
  if (!String(err).includes('BUSYGROUP')) throw err
}

let stopping = false
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => (stopping = true))

ready = true
log('ready', { pod: podName })

while (!stopping) {
  const res = (await redis.xreadgroup('GROUP', group, podName, 'COUNT', 1, 'BLOCK', 5000, 'STREAMS', stream, '>')) as
    | [string, [string, string[]][]][]
    | null
  if (!res) continue
  const [id, flat] = res[0][1][0]
  await redis.xack(stream, group, id)
  ready = false
  busy.set(1)
  log('job_received', { id })
  const job: Record<string, string> = {}
  for (let i = 0; i + 1 < flat.length; i += 2) job[flat[i]] = flat[i + 1]
  try {
    await runJob(job)
  } catch (err) {
    log('job failed', { err: String(err) })
  }
  log('ended')
  break // single-use pod: one job, then exit
}

await redis.xgroup('DELCONSUMER', stream, group, podName)
redis.disconnect()
server.close()
// rtc-node's native runtime keeps the event loop alive, so leave explicitly.
process.exit(0)

// runJob is the job path of pod-spec §3.1 and §4. The job carries the tokens itself (a
// spike shortcut for the /claim call of pod-spec §5.2).
async function runJob(job: Record<string, string>): Promise<void> {
  const { livekitUrl, language: lang, hostIdentity } = job

  const out = new Room()
  await out.connect(livekitUrl, job.outToken, { autoSubscribe: false, dynacast: false })
  const source = new AudioSource(24_000, 1)
  const track = LocalAudioTrack.createAudioTrack(lang, source)
  await out.localParticipant!.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }))

  // Gemini → out room: translated 24 kHz PCM onto the published track, in 10 ms frames.
  let queue = Promise.resolve()
  const onMessage = (m: LiveServerMessage) => {
    for (const p of m.serverContent?.modelTurn?.parts ?? []) {
      if (!p.inlineData?.data) continue
      const buf = Buffer.from(p.inlineData.data, 'base64')
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1)
      samplesOut.inc(pcm.length)
      queue = queue.then(async () => {
        for (let i = 0; i + 240 <= pcm.length; i += 240) {
          await source.captureFrame(new AudioFrame(pcm.slice(i, i + 240), 24_000, 1, 240))
        }
      })
    }
  }
  // Gemini Live Translate, configured as the prototype that ran against the real service
  // (main:backend/src/engine/gemini.ts). The Go worker sends the same config.
  const session = await gem.live.connect({
    model: env('GEMINI_MODEL', 'gemini-3.5-live-translate-preview'),
    config: {
      responseModalities: [Modality.AUDIO],
      translationConfig: { targetLanguageCode: lang, echoTargetLanguage: false },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: {},
    },
    callbacks: { onmessage: onMessage },
  })

  // src room → Gemini: the host's audio only, as 16 kHz mono in 100 ms chunks.
  const src = new Room()
  const ended = new Promise<void>((resolve) => src.on(RoomEvent.Disconnected, () => resolve()))
  const subscribe = (pub: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (participant.identity === hostIdentity && pub.kind === TrackKind.KIND_AUDIO) pub.setSubscribed(true)
  }
  src.on(RoomEvent.TrackPublished, subscribe)
  src.on(RoomEvent.TrackSubscribed, async (remote: RemoteTrack) => {
    // Both rooms joined, host subscribed, Gemini open: the track is live (pod-spec D7).
    log('live')
    let chunk: Buffer[] = []
    let bytes = 0
    for await (const frame of new AudioStream(remote, { sampleRate: 16_000, numChannels: 1 })) {
      const b = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength)
      chunk.push(Buffer.from(b))
      bytes += b.length
      if (bytes < 3200) continue // 100 ms at 16 kHz, 16-bit mono
      samplesIn.inc(bytes / 2)
      session.sendRealtimeInput({ audio: { data: Buffer.concat(chunk).toString('base64'), mimeType: 'audio/pcm;rate=16000' } })
      chunk = []
      bytes = 0
    }
  })
  await src.connect(livekitUrl, job.srcToken, { autoSubscribe: false, dynacast: false })
  // A host that published before we joined raises no TrackPublished: subscribe here.
  for (const participant of src.remoteParticipants.values()) {
    for (const pub of participant.trackPublications.values()) subscribe(pub, participant)
  }

  await ended
  session.close()
  await out.disconnect()
}
