// Bridge for ADR-0001, option 3: joins a live session as an ordinary WebSocket listener and
// publishes the translated audio into a LiveKit room as one track. This does the job the backend
// would do in the target architecture, without changing the backend.
//
//   npx tsx bridge.ts <joinCode> [lang]
import { AudioFrame, AudioSource, LocalAudioTrack, Room, TrackPublishOptions, TrackSource } from '@livekit/rtc-node'
import { AccessToken } from 'livekit-server-sdk'
import WebSocket from 'ws'

const [code, lang = 'sk'] = process.argv.slice(2)
if (!code) {
  console.error('usage: tsx bridge.ts <joinCode> [lang]')
  process.exit(2)
}
const RATE = 24_000 // the backend sends PCM16 mono at 24 kHz
const FRAME = RATE / 100 // feed LiveKit 10 ms frames
const room = `bench-${lang}`

// LiveKit only lets in clients with a signed token. devkey/secret are the --dev server's keys.
const token = new AccessToken('devkey', 'secret', { identity: 'bridge' })
token.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: false })

const lk = new Room()
await lk.connect('ws://localhost:7880', await token.toJwt())
const source = new AudioSource(RATE, 1)
const track = LocalAudioTrack.createAudioTrack(`dub-${lang}`, source)
await lk.localParticipant!.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }))
console.log(`publishing to LiveKit room "${room}"`)

// Chunks arrive every ~250 ms; queue them so frames reach LiveKit in order.
let queue = Promise.resolve()
const ws = new WebSocket(`ws://localhost:8080/api/ws/listen/${code}?lang=${lang}`)
ws.on('message', (data, isBinary) => {
  if (!isBinary) return // captions are JSON text
  const buf = data as Buffer
  const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length))
  queue = queue.then(async () => {
    for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
      await source.captureFrame(new AudioFrame(pcm.subarray(i, i + FRAME), RATE, 1, FRAME))
    }
  })
})
ws.on('error', (err: NodeJS.ErrnoException) => console.error(`could not join the session: ${err.code ?? err.message}`))
ws.on('close', async (closeCode) => {
  console.log(`session socket closed (code ${closeCode}); leaving LiveKit`)
  await lk.disconnect()
  process.exit(0)
})
