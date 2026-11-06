// Starts and ends the live-track job.
//
//   node dispatch.ts start <workerPodName>   mint the worker's tokens and XADD the job
//   node dispatch.ts end                     delete the rooms (the host "stops the session")
//
// In the real system Hono does both, and the worker gets its tokens from /claim
// (pod-spec D4, §5.2). Here the job carries them, so the spike needs no control API.
import { Redis } from 'ioredis'
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'

const url = process.env.LIVEKIT_URL ?? 'ws://livekit:7880'
const session = process.env.SESSION_ID ?? 'spike'
const lang = process.env.LANGUAGE ?? 'sk'
const srcRoom = `src-${session}`
const outRoom = `out-${session}-${lang}-0`
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }))

const [cmd, podName] = process.argv.slice(2)

if (cmd === 'start' && podName) {
  // Grants as in pod-spec §4.3.
  const src = new AccessToken('devkey', 'secret', { identity: podName })
  src.addGrant({ roomJoin: true, room: srcRoom, canSubscribe: true, canPublish: false, canPublishData: false, hidden: true })
  const out = new AccessToken('devkey', 'secret', { identity: `translator-t-${session}-${lang}` })
  out.addGrant({ roomJoin: true, room: outRoom, canPublish: true, canSubscribe: false })

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379')
  const id = await redis.xadd(
    process.env.JOB_STREAM ?? 'translate:jobs',
    '*',
    ...['jobId', `job-${Date.now()}`, 'sessionId', session, 'trackId', `t-${session}-${lang}`, 'language', lang],
    ...['livekitUrl', url, 'srcRoom', srcRoom, 'srcToken', await src.toJwt(), 'outRoom', outRoom, 'outToken', await out.toJwt()],
    ...['hostIdentity', `host-${session}`],
  )
  log('job sent', { id, srcRoom, outRoom })
  redis.disconnect()
} else if (cmd === 'end') {
  const rooms = new RoomServiceClient(url.replace(/^ws/, 'http'), 'devkey', 'secret')
  // Logged before the call, so measure.mjs times the worker's exit from the moment we ask.
  log('rooms deleted', { rooms: [srcRoom] })
  await rooms.deleteRoom(srcRoom)
  await rooms.deleteRoom(outRoom).catch(() => {})
} else {
  console.error('usage: node dispatch.ts start <workerPodName> | end')
  process.exit(2)
}
