import { createMicInput, idleMicState, type MicInput } from './mic'
import { Downsampler, Framer, floatToInt16 } from './pcm'
import { openRetrySocket, wsUrl, type RetrySocket } from './socket'
import { createStore } from './store'
import type { HostLive, HostLiveState } from './types'

// Close codes from the backend: 4401 not signed in, 4404 session not live, 4000 replaced by another host window.
const FATAL = [1000, 4000, 4401, 4404]
const MAX_BACKLOG = 512 * 1024 // don't queue more than ~16 s of mic audio if the network stalls

interface Run {
  dead: boolean
  ctx?: AudioContext
  node?: AudioWorkletNode
  mic?: MicInput
  unsubscribe: Array<() => void>
  sock?: RetrySocket
}

/**
 * Host side: captures the chosen microphone (echo cancellation and noise suppression on), converts
 * it to PCM16 mono 16 kHz in 100 ms frames, and sends it over a WebSocket. Captions come back as JSON.
 *
 * The capture graph (AudioContext -> worklet -> framing -> socket) stays put; MicInput swaps only
 * the source, so changing microphone mid-session needs no reconnect and leaves no gap.
 */
export function createHostLive(): HostLive {
  const store = createStore<HostLiveState>({
    status: 'connecting',
    original: '',
    translated: {},
    error: null,
    needsTap: false,
    mic: { ...idleMicState },
  })
  const level = createStore({ level: 0 })
  let run: Run | null = null
  let sessionId = ''
  /** Why streaming can't continue for a reason that isn't the microphone (another window, sign-in expired). */
  let sessionError: string | null = null

  /** Mirror the microphone's state into the host state, and decide what the studio should say about it. */
  const syncMic = (r: Run) => {
    if (r.dead || !r.mic) return
    const mic = r.mic.state.getState()
    store.setState({ mic, error: sessionError ?? mic.error })
  }

  const fail = (error: string) => {
    sessionError = error
    store.setState({ status: 'unavailable', error })
  }

  async function start(r: Run, id: string): Promise<void> {
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      r.ctx = ctx
      await ctx.audioWorklet.addModule('/pcm-capture.worklet.js')
      if (r.dead) return teardown(r)

      // Capture -> worklet -> (muted) -> destination. The muted hop keeps the graph running without echoing the mic.
      const node = new AudioWorkletNode(ctx, 'pcm-capture', { channelCount: 1, numberOfOutputs: 1 })
      r.node = node
      const mute = ctx.createGain()
      mute.gain.value = 0
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

      // The microphone feeds the worklet. Its state and level are mirrored for the studio's picker.
      const mic = createMicInput({ ctx, output: node })
      r.mic = mic
      r.unsubscribe.push(mic.state.subscribe(() => syncMic(r)))
      r.unsubscribe.push(mic.level.subscribe(() => level.setState(mic.level.getState())))
      await mic.start()
      if (r.dead) return teardown(r)
      if (mic.state.getState().status !== 'on') {
        syncMic(r)
        return void store.setState({ status: 'unavailable' }) // blocked, no device, no HTTPS...: nothing to stream
      }
    } catch {
      return fail('Couldn’t start audio capture in this browser.')
    }

    sessionError = null
    syncMic(r)
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
    r.unsubscribe.forEach((u) => u())
    r.unsubscribe = []
    r.sock?.close()
    r.mic?.stop() // releases the device; leaves the audio context to us
    if (r.node) {
      r.node.port.onmessage = null
      r.node.disconnect()
    }
    if (r.ctx) {
      r.ctx.onstatechange = null
      void r.ctx.close().catch(() => {})
    }
    level.setState({ level: 0 })
  }

  const host: HostLive = {
    ...store,
    micLevel: level,
    connect(id) {
      if (run) teardown(run)
      sessionId = id
      sessionError = null
      store.setState({ status: 'connecting', error: null, needsTap: false, original: '', translated: {}, mic: { ...idleMicState } })
      const r: Run = { dead: false, unsubscribe: [] }
      run = r
      void start(r, id)
    },
    resume() {
      // After an error: start over. Otherwise the tap just unlocks the suspended audio context.
      if (!run?.ctx || store.getState().error) host.connect(sessionId)
      else void run.ctx.resume()
    },
    selectMic(choice) {
      void run?.mic?.select(choice)
    },
    disconnect() {
      if (run) teardown(run)
      run = null
    },
  }
  return host
}
