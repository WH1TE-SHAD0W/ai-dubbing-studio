import { getAudioContext } from '../lib/audio'
import { LISTEN_RATE, PlaybackScheduler, int16BytesToFloat } from './pcm'
import { openRetrySocket, wsUrl, type RetrySocket } from './socket'
import { createStore } from './store'
import type { ListenerLive, ListenerLiveState } from './types'

// 1000 = session ended, 4404 = not live, 4400 = unknown language. Anything else is retried.
const FATAL = [1000, 4400, 4404]

interface Run {
  dead: boolean
  gain: GainNode
  sched: PlaybackScheduler
  sources: Set<AudioBufferSourceNode>
  sock?: RetrySocket
  onState: () => void
}

/**
 * Listener side: receives translated PCM16 mono 24 kHz over a WebSocket and plays it through the
 * shared AudioContext (unlocked by the tap on the audio-check screen), with a small jitter buffer
 * and bounded lag. Captions and state arrive as JSON on the same socket.
 */
export function createListenerLive(): ListenerLive {
  const store = createStore<ListenerLiveState>({
    status: 'connecting',
    speaker: { name: '', speaking: false },
    original: '',
    translated: '',
    audioBlocked: false,
    trackDown: false,
  })
  let run: Run | null = null
  let code = ''
  let lang = ''
  let volume = 0.7
  let muted = false

  const level = () => (muted ? 0 : volume)
  const applyLevel = () => {
    if (run) run.gain.gain.setTargetAtTime(level(), getAudioContext().currentTime, 0.015)
  }

  function stopSources(r: Run): void {
    for (const s of r.sources) {
      try {
        s.stop()
      } catch {
        /* already ended */
      }
    }
    r.sources.clear()
    r.sched.reset()
  }

  function play(r: Run, buf: ArrayBuffer): void {
    const ac = getAudioContext()
    // While the browser is holding audio back, drop instead of queueing: queued audio would all
    // play late the moment the listener taps.
    if (ac.state !== 'running') return
    const samples = int16BytesToFloat(buf)
    if (samples.length === 0) return

    const audio = ac.createBuffer(1, samples.length, LISTEN_RATE)
    audio.copyToChannel(samples, 0)
    const placement = r.sched.place(ac.currentTime, audio.duration)
    if (!placement) return // hopelessly far behind: skip this chunk

    const src = ac.createBufferSource()
    src.buffer = audio
    src.playbackRate.value = placement.rate
    src.connect(r.gain)
    src.onended = () => r.sources.delete(src)
    r.sources.add(src)
    src.start(placement.start)
  }

  function handleJson(text: string): void {
    try {
      const m = JSON.parse(text) as {
        type?: string
        original?: string
        translated?: string
        speaking?: boolean
        trackDown?: boolean
      }
      switch (m.type) {
        case 'caption':
          store.setState({ original: m.original ?? '', translated: m.translated ?? '' })
          break
        case 'speaker':
          store.setState({ speaker: { ...store.getState().speaker, speaking: !!m.speaking } })
          break
        case 'status':
          store.setState({ trackDown: !!m.trackDown })
          break
        case 'ended':
          store.setState({ status: 'ended' })
          break
      }
    } catch {
      /* ignore malformed frames */
    }
  }

  function teardown(r: Run): void {
    r.dead = true
    r.sock?.close()
    stopSources(r)
    r.gain.disconnect()
    getAudioContext().removeEventListener('statechange', r.onState)
  }

  const live: ListenerLive = {
    ...store,

    connect(c, l) {
      if (run) teardown(run)
      code = c
      lang = l
      const ac = getAudioContext()
      const gain = ac.createGain()
      gain.gain.value = level()
      gain.connect(ac.destination)

      const r: Run = {
        dead: false,
        gain,
        sched: new PlaybackScheduler(),
        sources: new Set(),
        onState: () => store.setState({ audioBlocked: ac.state !== 'running' }),
      }
      run = r
      ac.addEventListener('statechange', r.onState)
      store.setState({
        status: 'connecting',
        original: '',
        translated: '',
        trackDown: false,
        speaker: { name: '', speaking: false },
        audioBlocked: ac.state !== 'running',
      })

      r.sock = openRetrySocket({
        url: () => wsUrl(`/ws/listen/${encodeURIComponent(code)}?lang=${encodeURIComponent(lang)}`),
        fatalCodes: FATAL,
        onOpen: () => store.setState({ status: 'live' }),
        onMessage: (data) => (typeof data === 'string' ? handleJson(data) : play(r, data)),
        onDown: ({ fatal }) => store.setState({ status: fatal ? 'ended' : 'reconnecting' }),
      })
    },

    setLanguage(l) {
      lang = l
      if (!run) return
      stopSources(run) // don't let the old language finish talking over the new one
      store.setState({ translated: '', trackDown: false })
      run.sock?.send(JSON.stringify({ type: 'lang', lang: l }))
    },

    setVolume(v) {
      volume = v
      applyLevel()
    },

    setMuted(m) {
      muted = m
      applyLevel()
    },

    resumeAudio() {
      void getAudioContext().resume()
    },

    disconnect() {
      if (run) teardown(run)
      run = null
    },
  }
  return live
}
