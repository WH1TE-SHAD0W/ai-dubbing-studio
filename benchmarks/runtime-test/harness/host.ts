// The host for the live-track scenario: joins the source room as host-{sessionId} and
// loops a speech recording (audio/speech.wav, PCM16 mono, any rate; make-speech-wav.ps1
// makes one) in 10 ms frames until it is stopped. The worker subscribes to this track, as
// it would to the host's microphone, and Gemini translates it.
import { readFileSync } from 'node:fs'
import { AudioFrame, AudioSource, LocalAudioTrack, Room, TrackPublishOptions, TrackSource } from '@livekit/rtc-node'
import { AccessToken } from 'livekit-server-sdk'

const url = process.env.LIVEKIT_URL ?? 'ws://livekit:7880'
const session = process.env.SESSION_ID ?? 'spike'
const wavPath = process.env.SPEECH_WAV ?? 'audio/speech.wav'
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }))

function readWav(path: string): { rate: number; pcm: Int16Array } {
  const b = readFileSync(path)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file')
  let fmt: { channels: number; rate: number; bits: number } | undefined
  for (let i = 12; i + 8 <= b.length; ) {
    const id = b.toString('ascii', i, i + 4)
    const size = b.readUInt32LE(i + 4)
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(i + 10), rate: b.readUInt32LE(i + 12), bits: b.readUInt16LE(i + 22) }
    if (id === 'data') {
      if (!fmt || fmt.channels !== 1 || fmt.bits !== 16) throw new Error(`need PCM16 mono, got ${JSON.stringify(fmt)}`)
      const data = b.subarray(i + 8, i + 8 + size)
      return { rate: fmt.rate, pcm: new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)) }
    }
    i += 8 + size + (size % 2)
  }
  throw new Error('no data chunk')
}

const { rate, pcm: clip } = readWav(wavPath)
const FRAME = rate / 100

// devkey / secret are livekit-server --dev's keys.
const at = new AccessToken('devkey', 'secret', { identity: `host-${session}` })
at.addGrant({ roomJoin: true, room: `src-${session}`, canPublish: true, canSubscribe: false })

const room = new Room()
await room.connect(url, await at.toJwt(), { autoSubscribe: false, dynacast: false })
const source = new AudioSource(rate, 1)
const track = LocalAudioTrack.createAudioTrack('mic', source)
await room.localParticipant!.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }))
log('publishing', { room: `src-${session}`, audio: wavPath, seconds: clip.length / rate, rate })

let stop = false
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => (stop = true))

for (let i = 0; !stop; i = (i + FRAME) % (clip.length - (clip.length % FRAME))) {
  // captureFrame waits while the source's queue is full, which paces this loop to real time.
  await source.captureFrame(new AudioFrame(clip.slice(i, i + FRAME), rate, 1, FRAME))
}
await room.disconnect()
process.exit(0)
