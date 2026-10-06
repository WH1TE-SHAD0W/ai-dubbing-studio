import { load, save } from '../lib/storage'
import { createStore } from './store'
import type { Store } from './types'

// Microphone selection, shared by the studio (which streams it) and the Create-session test step
// (which only shows a level meter). Switching is make-before-break: the new device is opened and
// connected before the old one is released, so audio keeps flowing without a gap and without
// touching the audio context or the WebSocket.

/**
 * RMS above which audio counts as speech. Keep in sync with LOUD_RMS in backend/src/session/session.ts,
 * which warns when the host's audio never gets this loud.
 */
export const SPEECH_RMS = 0.012

const MIN_DB = -60
const MAX_DB = -10
const STORAGE_KEY = 'ads.mic'
const BASE_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }

export interface MicDevice {
  id: string
  label: string
}

export type MicStatus =
  | 'idle' // not capturing (not started, stopped, or failed for a reason other than permission)
  | 'starting'
  | 'on'
  | 'blocked' // permission denied
  | 'unsupported' // no mediaDevices (plain http off localhost)
  | 'lost' // the device went away and the fallback failed too

export interface MicState {
  status: MicStatus
  devices: MicDevice[]
  /** '' means "system default"; otherwise a deviceId. */
  choice: string
  /** Name of the device that is actually capturing. */
  activeLabel: string | null
  switching: boolean
  /** Something the host should know (not an error): a fallback happened, a switch failed. */
  notice: string | null
  /** Why the mic isn't capturing. */
  error: string | null
  /** Speech-level audio has been heard since the last start or switch. */
  heard: boolean
  /** The mic is on but nothing speech-like has been heard for a while. */
  silent: boolean
}

export const idleMicState: MicState = {
  status: 'idle',
  devices: [],
  choice: '',
  activeLabel: null,
  switching: false,
  notice: null,
  error: null,
  heard: false,
  silent: false,
}

export type MicMediaDevices = Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices' | 'addEventListener' | 'removeEventListener'>

export interface MicDeps {
  /** The audio context to analyse and route through. Pass `ctx`, or `ctxFactory` to create it only when first needed. */
  ctx?: AudioContext
  ctxFactory?: () => AudioContext
  /** Where captured audio goes (the capture worklet). Omit for a meter-only preview. */
  output?: AudioNode
  mediaDevices?: MicMediaDevices
  /** The remembered choice. Defaults to localStorage. */
  saved?: { get(): string; set(deviceId: string): void }
  now?: () => number
  levelIntervalMs?: number
  noSoundAfterMs?: number
}

const defaultSaved = {
  get: () => load<{ deviceId: string }>(STORAGE_KEY)?.deviceId ?? '',
  set: (deviceId: string) => save(STORAGE_KEY, { deviceId }),
}

/** RMS (0..1) to a 0..1 meter position: -60 dBFS is empty, -10 dBFS is full. */
export function levelFromRms(rms: number): number {
  if (!(rms > 0)) return 0
  const db = 20 * Math.log10(rms)
  return Math.min(1, Math.max(0, (db - MIN_DB) / (MAX_DB - MIN_DB)))
}

/** Where SPEECH_RMS sits on the meter, for the threshold tick. */
export const SPEECH_LEVEL = levelFromRms(SPEECH_RMS)

/** Chrome adds virtual "default" and "communications" entries that duplicate real devices; drop them. */
export function micOptions(all: MediaDeviceInfo[]): MicDevice[] {
  const real = all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
  return real.map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
}

/** Chrome labels the default device "Default - <name>". */
export function cleanLabel(label: string): string {
  return label.replace(/^default\s*-\s*/i, '')
}

export function audioConstraints(deviceId: string): MediaStreamConstraints {
  return { audio: deviceId ? { ...BASE_AUDIO, deviceId: { exact: deviceId } } : { ...BASE_AUDIO } }
}

const errName = (e: unknown): string => (e as { name?: string } | null)?.name ?? ''
/** The requested device is gone or can't satisfy the request. */
const isDeviceGone = (e: unknown) => errName(e) === 'OverconstrainedError' || errName(e) === 'NotFoundError'

function describeFailure(e: unknown): { status: MicStatus; error: string } {
  switch (errName(e)) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { status: 'blocked', error: 'Microphone access was blocked. Allow it in your browser, then try again.' }
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { status: 'idle', error: 'No microphone was found. Plug one in and try again.' }
    case 'NotReadableError':
    case 'AbortError':
      return { status: 'idle', error: 'The microphone is busy or unavailable. Another app may be using it.' }
    default:
      return { status: 'idle', error: 'Couldn’t start the microphone.' }
  }
}

export interface MicInput {
  readonly state: Store<MicState>
  /** Loudness for the meter, updated ~10 times a second. Separate so only the meter re-renders. */
  readonly level: Store<{ level: number }>
  start(): Promise<void>
  /** Choose a device ('' = system default). Remembered for next time. */
  select(choice: string): Promise<void>
  refreshDevices(): Promise<void>
  /** Release the microphone. Never closes the audio context it was given. */
  stop(): void
}

export function createMicInput(deps: MicDeps): MicInput {
  // Looked up when needed, not when created: the screen builds this before anything is requested.
  const mediaDevices = (): MicMediaDevices | undefined =>
    deps.mediaDevices ?? (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined)
  let listeningOn: MicMediaDevices | undefined
  const saved = deps.saved ?? defaultSaved
  const now = deps.now ?? Date.now
  const levelEvery = deps.levelIntervalMs ?? 100
  const noSoundAfter = deps.noSoundAfterMs ?? 5000
  let ctx: AudioContext | null = deps.ctx ?? null
  const audioCtx = (): AudioContext => (ctx ??= deps.ctxFactory!())

  const state = createStore<MicState>({ ...idleMicState })
  const level = createStore({ level: 0 })

  let stream: MediaStream | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let analyser: AnalyserNode | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  let seq = 0 // newest request wins: a result that arrives for an older one is discarded
  let sinceAt = 0
  let lastHeardAt = 0
  const endedHandlers = new Map<MediaStreamTrack, () => void>()

  const onDeviceChange = () => void refreshDevices()

  const open = (deviceId: string): Promise<MediaStream> => {
    const md = mediaDevices()
    if (!md) return Promise.reject(Object.assign(new Error('no mediaDevices'), { name: 'NotSupportedError' }))
    return md.getUserMedia(audioConstraints(deviceId))
  }

  const labelOf = (s: MediaStream): string => cleanLabel(s.getAudioTracks()[0]?.label ?? '')

  const release = (s: MediaStream) => {
    for (const t of s.getAudioTracks()) {
      const h = endedHandlers.get(t)
      if (h) t.removeEventListener('ended', h)
      endedHandlers.delete(t)
    }
    s.getTracks().forEach((t) => t.stop())
  }

  const watch = (s: MediaStream) => {
    for (const t of s.getAudioTracks()) {
      const h = () => {
        if (stream !== s) return
        // The device went away (unplugged, Bluetooth dropped): carry on with the system default.
        void switchTo('', { persist: false, notice: 'Microphone disconnected, switched to the system default.', recovering: true })
      }
      endedHandlers.set(t, h)
      t.addEventListener('ended', h)
    }
  }

  /** Connect `next`, then retire the previous stream (make-before-break). */
  const attach = (next: MediaStream) => {
    const nextSource = audioCtx().createMediaStreamSource(next)
    if (!analyser) {
      analyser = audioCtx().createAnalyser()
      analyser.fftSize = 1024
    }
    nextSource.connect(analyser)
    if (deps.output) nextSource.connect(deps.output)

    const oldSource = source
    const oldStream = stream
    source = nextSource
    stream = next
    watch(next)

    if (oldSource) {
      try {
        oldSource.disconnect()
      } catch {
        /* already disconnected */
      }
    }
    if (oldStream) release(oldStream)

    sinceAt = lastHeardAt = now()
    if (!timer) timer = setInterval(measure, levelEvery)
  }

  const measure = () => {
    if (!analyser) return
    const buf = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += v * v
    const r = Math.sqrt(sum / buf.length)

    const shown = Math.round(levelFromRms(r) * 100) / 100
    if (shown !== level.getState().level) level.setState({ level: shown })

    const t = now()
    const s = state.getState()
    if (r > SPEECH_RMS) {
      lastHeardAt = t
      if (!s.heard || s.silent) state.setState({ heard: true, silent: false })
    } else if (!s.silent && ctx?.state === 'running' && t - sinceAt > noSoundAfter && t - lastHeardAt > noSoundAfter) {
      state.setState({ silent: true }) // a suspended context reads as silence, so only judge a running one
    }
  }

  async function refreshDevices(): Promise<void> {
    const md = mediaDevices()
    if (!md?.enumerateDevices) return
    try {
      state.setState({ devices: micOptions(await md.enumerateDevices()) })
    } catch {
      /* keep the previous list */
    }
  }

  async function start(): Promise<void> {
    const md = mediaDevices()
    if (!md?.getUserMedia) {
      state.setState({ status: 'unsupported', error: 'The microphone needs HTTPS (or localhost) to work.' })
      return
    }
    const mine = ++seq
    state.setState({ status: 'starting', error: null, notice: null, heard: false, silent: false })
    if (!listeningOn) {
      md.addEventListener?.('devicechange', onDeviceChange)
      listeningOn = md
    }

    let choice = saved.get()
    let opened: MediaStream
    try {
      opened = await open(choice)
    } catch (e) {
      if (!(choice && isDeviceGone(e))) return failStart(e, mine)
      // The remembered microphone isn't connected right now. Keep it remembered (it may come back).
      try {
        opened = await open('')
        choice = ''
        state.setState({ notice: 'Your saved microphone isn’t connected, so the system default is in use.' })
      } catch (e2) {
        return failStart(e2, mine)
      }
    }
    if (mine !== seq) return release(opened) // stopped or restarted while the prompt was open

    attach(opened)
    state.setState({ status: 'on', choice, activeLabel: labelOf(opened) || null, error: null })
    await refreshDevices() // labels only exist once permission has been granted
  }

  function failStart(e: unknown, mine: number): void {
    if (mine !== seq) return
    state.setState({ ...describeFailure(e) })
  }

  async function switchTo(
    choice: string,
    opts: { persist: boolean; notice?: string; recovering?: boolean },
  ): Promise<void> {
    if (!stream && !opts.recovering) {
      // Not running yet: remember the choice and start with it.
      if (opts.persist) saved.set(choice)
      return start()
    }
    const mine = ++seq
    state.setState({ switching: true })

    let next: MediaStream
    try {
      next = await open(choice)
    } catch (e) {
      if (mine !== seq) return
      if (opts.recovering) {
        // The old device is gone and so is the fallback: nothing is capturing any more.
        state.setState({
          switching: false,
          status: 'lost',
          error: 'The microphone was disconnected and no other input is available. Plug one in and try again.',
        })
      } else {
        const wanted = state.getState().devices.find((d) => d.id === choice)?.label ?? (choice ? 'that microphone' : 'the system default')
        const current = state.getState().activeLabel ?? 'the current microphone'
        state.setState({ switching: false, notice: `Couldn’t switch to ${wanted}. Still using ${current}.` })
      }
      return
    }
    if (mine !== seq) return release(next) // a newer request superseded this one

    attach(next)
    if (opts.persist) saved.set(choice)
    state.setState({
      switching: false,
      status: 'on',
      choice,
      activeLabel: labelOf(next) || null,
      notice: opts.notice ?? null,
      error: null,
      heard: false,
      silent: false,
    })
    await refreshDevices()
  }

  function stop(): void {
    seq++ // discard anything still in flight
    clearInterval(timer)
    timer = undefined
    if (listeningOn) {
      listeningOn.removeEventListener?.('devicechange', onDeviceChange)
      listeningOn = undefined
    }
    if (source) {
      try {
        source.disconnect()
      } catch {
        /* already disconnected */
      }
      source = null
    }
    if (stream) {
      release(stream)
      stream = null
    }
    if (analyser) {
      try {
        analyser.disconnect()
      } catch {
        /* already disconnected */
      }
      analyser = null
    }
    level.setState({ level: 0 })
    state.setState({ status: 'idle', switching: false, activeLabel: null, heard: false, silent: false })
  }

  return {
    state,
    level,
    start,
    select: (choice) => switchTo(choice, { persist: true }),
    refreshDevices,
    stop,
  }
}
