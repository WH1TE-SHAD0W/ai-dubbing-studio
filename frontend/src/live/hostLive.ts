import { Downsampler, Framer, floatToInt16 } from './pcm'
import { openRetrySocket, wsUrl, type RetrySocket } from './socket'
import { createStore } from './store'
import type { HostLive, HostLiveState } from './types'

// Close codes from the backend: 4401 not signed in, 4404 session not live, 4000 replaced by another host window.
const FATAL = [1000, 4000, 4401, 4404]
const MAX_BACKLOG = 512 * 1024 // don't queue more than ~16 s of mic audio if the network stalls

interface Run {
  dead: boolean
  stream?: MediaStream
  ctx?: AudioContext
  node?: AudioWorkletNode
  sock?: RetrySocket
}

/**
 * Host side: captures the mic (echo cancellation and noise suppression on), converts it to
 * PCM16 mono 16 kHz in 100 ms frames, and sends it over a WebSocket. Captions come back as JSON.
 */
export function createHostLive(): HostLive {
  const store = createStore<HostLiveState>({
    status: 'connecting',
    original: '',
    translated: {},
    error: null,
    needsTap: false,
  })
  let run: Run | null = null
  let sessionId = ''

  const fail = (error: string) => store.setState({ status: 'unavailable', error })

  async function start(r: Run, id: string): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) return fail('The microphone needs HTTPS (or localhost) to work.')

    try {
      r.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      })
    } catch {
      return fail('Microphone access was blocked. Allow it in your browser, then try again.')
    }
    if (r.dead) return teardown(r)

    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      r.ctx = ctx
      await ctx.audioWorklet.addModule('/pcm-capture.worklet.js')
      if (r.dead) return teardown(r)

      // Capture -> worklet -> (muted) -> destination. The muted hop keeps the graph running without echoing the mic.
      const source = ctx.createMediaStreamSource(r.stream)
      const node = new AudioWorkletNode(ctx, 'pcm-capture', { channelCount: 1, numberOfOutputs: 1 })
      r.node = node
      const mute = ctx.createGain()
      mute.gain.value = 0
      source.connect(node)
      node.connect(mute).connect(ctx.destination)

      const down = new Downsampler(ctx.sampleRate)
      const framer = new Framer()
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        const frames = framer.push(floatToInt16(down.process(new Float32Array(e.data))))
        for (const frame of frames) {
          if ((r.sock?.socket?.bufferedAmount ?? 0) < MAX_BACKLOG) r.sock?.send(frame.buffer)
        }
      }

      ctx.onstatechange = () => store.setState({ needsTap: ctx.state !== 'running' })
      void ctx.resume() // allowed after a tap; otherwise stays suspended and we ask for one
      store.setState({ needsTap: ctx.state !== 'running' })
    } catch {
      return fail('Couldn’t start audio capture in this browser.')
    }

    store.setState({ error: null })
    r.sock = openRetrySocket({
      url: () => wsUrl(`/ws/host/${encodeURIComponent(id)}`),
      fatalCodes: FATAL,
      onOpen: () => store.setState({ status: 'live' }),
      onMessage: (data) => {
        if (typeof data !== 'string') return
        try {
          const m = JSON.parse(data) as { type?: string; original?: string; translated?: Record<string, string>; ended?: boolean }
          if (m.type === 'caption') store.setState({ original: m.original ?? '', translated: m.translated ?? {} })
          else if (m.type === 'status' && m.ended) store.setState({ status: 'ended' })
        } catch {
          /* ignore malformed frames */
        }
      },
      onDown: ({ code, fatal }) => {
        if (!fatal) return store.setState({ status: 'reconnecting' })
        if (code === 4000) fail('The microphone is now streaming from another window.')
        else if (code === 4401) fail('Your sign-in expired. Sign in again to keep streaming.')
        else store.setState({ status: 'ended' })
      },
    })
  }

  function teardown(r: Run): void {
    r.dead = true
    r.sock?.close()
    if (r.node) {
      r.node.port.onmessage = null
      r.node.disconnect()
    }
    r.stream?.getTracks().forEach((t) => t.stop())
    if (r.ctx) {
      r.ctx.onstatechange = null
      void r.ctx.close().catch(() => {})
    }
  }

  const host: HostLive = {
    ...store,
    connect(id) {
      if (run) teardown(run)
      sessionId = id
      store.setState({ status: 'connecting', error: null, needsTap: false, original: '', translated: {} })
      const r: Run = { dead: false }
      run = r
      void start(r, id)
    },
    resume() {
      // After an error: start over. Otherwise the tap just unlocks the suspended audio context.
      if (!run?.ctx || store.getState().error) host.connect(sessionId)
      else void run.ctx.resume()
    },
    disconnect() {
      if (run) teardown(run)
      run = null
    },
  }
  return host
}
