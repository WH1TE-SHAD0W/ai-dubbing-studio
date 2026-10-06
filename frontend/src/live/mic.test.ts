import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeAudioContext, FakeMediaDevices } from '../test/audioFakes'
import {
  SPEECH_LEVEL,
  SPEECH_RMS,
  audioConstraints,
  cleanLabel,
  createMicInput,
  levelFromRms,
  micOptions,
} from './mic'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function setup(savedId = '') {
  const md = new FakeMediaDevices()
  const ctx = new FakeAudioContext()
  let saved = savedId
  const mic = createMicInput({
    ctx: ctx.asCtx(),
    output: ctx.output as unknown as AudioNode,
    mediaDevices: md.asDeps(),
    saved: { get: () => saved, set: (id) => (saved = id) },
  })
  return { md, ctx, mic, savedId: () => saved, state: () => mic.state.getState() }
}

describe('helpers', () => {
  it('maps loudness to a meter position on a dB scale', () => {
    expect(levelFromRms(0)).toBe(0)
    expect(levelFromRms(0.0001)).toBe(0) // below -60 dBFS
    expect(levelFromRms(1)).toBe(1)
    expect(levelFromRms(0.1)).toBeCloseTo(0.8, 5) // -20 dBFS
    expect(SPEECH_LEVEL).toBeCloseTo(0.43, 1)
    expect(levelFromRms(SPEECH_RMS)).toBe(SPEECH_LEVEL)
  })

  it('lists real microphones only, dropping Chrome’s virtual duplicates, and names unlabeled ones', () => {
    const md = new FakeMediaDevices()
    expect(micOptions(md.devices as never)).toEqual([
      { id: 'mic-a', label: 'Built-in Mic' },
      { id: 'mic-b', label: 'USB Headset' },
    ])
    expect(micOptions([{ deviceId: 'x', label: '', kind: 'audioinput' }, { deviceId: 'y', label: '', kind: 'audioinput' }] as never)).toEqual([
      { id: 'x', label: 'Microphone 1' },
      { id: 'y', label: 'Microphone 2' },
    ])
  })

  it('cleans the default device label', () => {
    expect(cleanLabel('Default - Built-in Mic')).toBe('Built-in Mic')
    expect(cleanLabel('USB Headset')).toBe('USB Headset')
  })

  it('asks for a specific device exactly, and keeps echo cancellation and noise suppression on', () => {
    const def = audioConstraints('').audio as MediaTrackConstraints
    expect(def.deviceId).toBeUndefined()
    const chosen = audioConstraints('mic-b').audio as MediaTrackConstraints
    expect(chosen.deviceId).toEqual({ exact: 'mic-b' })
    for (const c of [def, chosen]) expect(c).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 })
  })
})

describe('starting', () => {
  it('opens the system default and lists devices (with labels, since permission is now granted)', async () => {
    const { mic, state, md, ctx } = setup()
    await mic.start()
    expect(state()).toMatchObject({ status: 'on', choice: '', activeLabel: 'Built-in Mic', error: null })
    expect(state().devices.map((d) => d.label)).toEqual(['Built-in Mic', 'USB Headset'])
    expect(md.calls).toHaveLength(1)
    // captured audio goes to the meter and to the capture worklet
    expect(ctx.log).toContain('connect source(Default - Built-in Mic) -> analyser')
    expect(ctx.log).toContain('connect source(Default - Built-in Mic) -> worklet')
  })

  it('is meter-only without an output node', async () => {
    const md = new FakeMediaDevices()
    const ctx = new FakeAudioContext()
    const mic = createMicInput({ ctx: ctx.asCtx(), mediaDevices: md.asDeps(), saved: { get: () => '', set: () => {} } })
    await mic.start()
    expect(ctx.log.some((l) => l.includes('worklet'))).toBe(false)
  })

  it('looks up the browser’s microphone API when starting, not when created', async () => {
    const md = new FakeMediaDevices()
    const ctx = new FakeAudioContext()
    const mic = createMicInput({ ctx: ctx.asCtx(), saved: { get: () => '', set: () => {} } }) // no injected mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true }) // appears afterwards
    try {
      await mic.start()
      expect(mic.state.getState().status).toBe('on')
      expect(md.calls).toHaveLength(1)
    } finally {
      mic.stop()
      Reflect.deleteProperty(navigator, 'mediaDevices')
    }
  })

  it('reports unsupported when the browser has no microphone API (plain http)', async () => {
    const ctx = new FakeAudioContext()
    const mic = createMicInput({ ctx: ctx.asCtx(), mediaDevices: undefined, saved: { get: () => '', set: () => {} } })
    // navigator.mediaDevices is undefined in jsdom, so this is the real no-API path
    await mic.start()
    expect(mic.state.getState()).toMatchObject({ status: 'unsupported' })
    expect(mic.state.getState().error).toMatch(/https/i)
  })

  it.each([
    ['NotAllowedError', 'blocked', /blocked/i],
    ['NotFoundError', 'idle', /no microphone/i],
    ['NotReadableError', 'idle', /busy/i],
    ['SomethingElse', 'idle', /couldn’t start/i],
  ])('explains a %s failure', async (name, status, message) => {
    const { mic, state, md } = setup()
    md.failures.set('', name)
    await mic.start()
    expect(state().status).toBe(status)
    expect(state().error).toMatch(message)
  })

  it('uses the remembered microphone', async () => {
    const { mic, state, md } = setup('mic-b')
    await mic.start()
    expect(md.calls[0]!.deviceId).toBe('mic-b')
    expect(state()).toMatchObject({ choice: 'mic-b', activeLabel: 'USB Headset' })
  })

  it('falls back to the default when the remembered microphone is gone, and still remembers it', async () => {
    const { mic, state, md, savedId } = setup('mic-gone')
    md.failures.set('mic-gone', 'OverconstrainedError')
    await mic.start()
    expect(state()).toMatchObject({ status: 'on', choice: '', activeLabel: 'Built-in Mic' })
    expect(state().notice).toMatch(/saved microphone/i)
    expect(savedId()).toBe('mic-gone') // it may come back
  })

  it('releases a stream that arrives after stop() (permission prompt answered too late)', async () => {
    const { mic, md, state } = setup()
    md.hold('')
    const starting = mic.start()
    mic.stop()
    md.release('')
    await starting
    expect(md.liveStreams()).toHaveLength(0)
    expect(state().status).toBe('idle')
  })
})

describe('switching', () => {
  it('connects the new device BEFORE releasing the old one, so audio never stops', async () => {
    const { mic, md, ctx, state, savedId } = setup()
    await mic.start()
    ctx.log.length = 0
    const first = md.streams[0]!

    await mic.select('mic-b')

    const connectNew = ctx.log.indexOf('connect source(USB Headset) -> worklet')
    const disconnectOld = ctx.log.indexOf('disconnect source(Default - Built-in Mic)')
    expect(connectNew).toBeGreaterThanOrEqual(0)
    expect(disconnectOld).toBeGreaterThan(connectNew)
    expect(ctx.log).toContain('connect source(USB Headset) -> analyser')
    expect(first.track.stopped).toBe(true)
    expect(md.liveStreams()).toHaveLength(1)
    expect(state()).toMatchObject({ choice: 'mic-b', activeLabel: 'USB Headset', switching: false, notice: null })
    expect(savedId()).toBe('mic-b')
  })

  it('keeps the old microphone running when the switch fails, and says so', async () => {
    const { mic, md, state, savedId } = setup()
    await mic.start()
    md.failures.set('mic-b', 'NotReadableError')

    await mic.select('mic-b')

    expect(md.streams[0]!.track.stopped).toBe(false)
    expect(state()).toMatchObject({ status: 'on', choice: '', switching: false })
    expect(state().notice).toMatch(/couldn’t switch to usb headset.*still using built-in mic/i)
    expect(savedId()).toBe('') // a failed choice isn't remembered
  })

  it('marks itself as switching while the new device opens', async () => {
    const { mic, md, state } = setup()
    await mic.start()
    md.hold('mic-b')
    const p = mic.select('mic-b')
    expect(state().switching).toBe(true)
    md.release('mic-b')
    await p
    expect(state().switching).toBe(false)
  })

  it('lets the newest choice win when the host changes their mind quickly', async () => {
    const { mic, md, state } = setup()
    await mic.start()
    md.hold('mic-b')
    const toB = mic.select('mic-b') // slow
    const toA = mic.select('mic-a') // fast, newer
    await toA
    md.release('mic-b') // the slow one finally resolves
    await toB

    expect(state()).toMatchObject({ choice: 'mic-a', activeLabel: 'Built-in Mic', switching: false })
    expect(md.liveStreams()).toHaveLength(1) // nothing leaked
    expect(md.liveStreams()[0]!.track.deviceId).toBe('mic-a')
  })

  it('starts with the choice when selecting before the microphone is running', async () => {
    const { mic, md, state, savedId } = setup()
    await mic.select('mic-b')
    expect(md.calls[0]!.deviceId).toBe('mic-b')
    expect(state()).toMatchObject({ status: 'on', choice: 'mic-b' })
    expect(savedId()).toBe('mic-b')
  })
})

describe('losing the microphone', () => {
  it('falls back to the system default and tells the host', async () => {
    const { mic, md, state, savedId, ctx } = setup('mic-b')
    await mic.start()
    ctx.log.length = 0

    md.streams[0]!.track.unplug()
    await vi.advanceTimersByTimeAsync(0)

    expect(state()).toMatchObject({ status: 'on', choice: '', activeLabel: 'Built-in Mic' })
    expect(state().notice).toMatch(/disconnected, switched to the system default/i)
    expect(savedId()).toBe('mic-b') // the unplugged device stays remembered
    expect(ctx.log).toContain('connect source(Default - Built-in Mic) -> worklet')
    expect(md.liveStreams()).toHaveLength(1)
  })

  it('reports the microphone as lost when there is nothing to fall back to', async () => {
    const { mic, md, state } = setup('mic-b')
    await mic.start()
    md.failures.set('', 'NotFoundError')

    md.streams[0]!.track.unplug()
    await vi.advanceTimersByTimeAsync(0)

    expect(state().status).toBe('lost')
    expect(state().error).toMatch(/disconnected/i)
  })

  it('ignores the "ended" event of a stream we already replaced', async () => {
    const { mic, md, state } = setup()
    await mic.start()
    const old = md.streams[0]!
    await mic.select('mic-b')
    const callsBefore = md.calls.length
    old.track.unplug()
    await vi.advanceTimersByTimeAsync(0)
    expect(md.calls).toHaveLength(callsBefore)
    expect(state().choice).toBe('mic-b')
  })

  it('refreshes the device list when a device is plugged in', async () => {
    const { mic, md, state } = setup()
    await mic.start()
    expect(state().devices).toHaveLength(2)
    md.devices.push({ deviceId: 'mic-c', label: 'Bluetooth Mic', kind: 'audioinput' })
    md.dispatchEvent(new Event('devicechange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(state().devices.map((d) => d.label)).toEqual(['Built-in Mic', 'USB Headset', 'Bluetooth Mic'])
  })
})

describe('stopping', () => {
  it('releases the microphone, stops listening for hardware changes, and leaves the audio context alone', async () => {
    const { mic, md, state, ctx } = setup()
    await mic.start()
    mic.stop()
    expect(md.liveStreams()).toHaveLength(0)
    expect(state().status).toBe('idle')
    expect(mic.level.getState().level).toBe(0)
    expect(ctx.state).toBe('running') // never closed or suspended by the mic

    md.devices.push({ deviceId: 'mic-c', label: 'New', kind: 'audioinput' })
    md.dispatchEvent(new Event('devicechange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(state().devices.map((d) => d.id)).not.toContain('mic-c')
    mic.stop() // idempotent
  })
})

describe('level meter and "can you hear me"', () => {
  it('publishes the level about ten times a second', async () => {
    const { mic, ctx } = setup()
    await mic.start()
    ctx.analyser!.amplitude = 0.1
    await vi.advanceTimersByTimeAsync(150)
    expect(mic.level.getState().level).toBeCloseTo(0.8, 1)
    ctx.analyser!.amplitude = 0
    await vi.advanceTimersByTimeAsync(150)
    expect(mic.level.getState().level).toBe(0)
  })

  it('notes that speech-level sound was heard', async () => {
    const { mic, ctx, state } = setup()
    await mic.start()
    expect(state().heard).toBe(false)
    ctx.analyser!.amplitude = 0.05
    await vi.advanceTimersByTimeAsync(150)
    expect(state().heard).toBe(true)
  })

  it('warns when nothing is heard for a while, and clears it when sound returns', async () => {
    const { mic, ctx, state } = setup()
    await mic.start()
    await vi.advanceTimersByTimeAsync(4000)
    expect(state().silent).toBe(false)
    await vi.advanceTimersByTimeAsync(1500)
    expect(state().silent).toBe(true)

    ctx.analyser!.amplitude = 0.05
    await vi.advanceTimersByTimeAsync(150)
    expect(state().silent).toBe(false)
  })

  it('does not call a suspended audio context silent (it reads zeros until a tap)', async () => {
    const { mic, ctx, state } = setup()
    await mic.start()
    ctx.state = 'suspended'
    await vi.advanceTimersByTimeAsync(8000)
    expect(state().silent).toBe(false)
  })

  it('starts the "heard" and "silent" judgement over after a switch', async () => {
    const { mic, ctx, state } = setup()
    await mic.start()
    ctx.analyser!.amplitude = 0.05
    await vi.advanceTimersByTimeAsync(150)
    expect(state().heard).toBe(true)

    ctx.analyser!.amplitude = 0
    await mic.select('mic-b')
    expect(state().heard).toBe(false)
    await vi.advanceTimersByTimeAsync(5500)
    expect(state().silent).toBe(true)
  })
})
