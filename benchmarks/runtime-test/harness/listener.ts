// A listener for the live-track scenario: subscribes to the dubbed track in the out room
// and checks that audio is arriving. Every 10 s, and when the room closes, it logs:
//   - frames: 10 ms frames received;
//   - audibleFrames: frames that carry sound (RMS above a small threshold), so decoder
//     silence doesn't count as audio arriving;
//   - maxGapMs: the longest wait between two frames.
import { AudioStream, Room, RoomEvent, type RemoteTrack } from '@livekit/rtc-node'
import { AccessToken } from 'livekit-server-sdk'

const url = process.env.LIVEKIT_URL ?? 'ws://livekit:7880'
const session = process.env.SESSION_ID ?? 'spike'
const lang = process.env.LANGUAGE ?? 'sk'
const outRoom = `out-${session}-${lang}-0`
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }))

const at = new AccessToken('devkey', 'secret', { identity: 'listener-1' })
at.addGrant({ roomJoin: true, room: outRoom, canSubscribe: true, canPublish: false })

const stats = { frames: 0, audibleFrames: 0, maxGapMs: 0 }
let last = 0

const room = new Room()
room.on(RoomEvent.TrackSubscribed, async (track: RemoteTrack) => {
  log('subscribed', { track: track.name })
  for await (const frame of new AudioStream(track, { sampleRate: 24_000, numChannels: 1 })) {
    const now = performance.now()
    if (last) stats.maxGapMs = Math.max(stats.maxGapMs, Math.round(now - last))
    last = now
    stats.frames++
    let sum = 0
    for (const s of frame.data) sum += s * s
    if (Math.sqrt(sum / frame.data.length) > 100) stats.audibleFrames++
  }
})
room.on(RoomEvent.Disconnected, () => {
  log('stats', { final: true, ...stats })
  process.exit(0)
})
await room.connect(url, await at.toJwt(), { autoSubscribe: true, dynacast: false })
log('joined', { room: outRoom })
setInterval(() => log('stats', { final: false, ...stats }), 10_000)
