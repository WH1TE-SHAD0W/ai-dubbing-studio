// Test doubles for the microphone and Web Audio APIs, which jsdom doesn't provide.
import type { MicMediaDevices } from '../live/mic'

export class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live'
  stopped = false
  constructor(
    public label: string,
    public deviceId: string,
  ) {
    super()
  }
  stop() {
    this.stopped = true
    this.readyState = 'ended'
  }
  /** The device went away (unplugged, Bluetooth dropped). */
  unplug() {
    this.readyState = 'ended'
    this.dispatchEvent(new Event('ended'))
  }
}

export class FakeStream {
  constructor(readonly track: FakeTrack) {}
  getAudioTracks() {
    return [this.track]
  }
  getTracks() {
    return [this.track]
  }
}

export interface FakeDeviceInfo {
  deviceId: string
  label: string
  kind: 'audioinput' | 'audiooutput'
}

/** Controllable stand-in for navigator.mediaDevices. */
export class FakeMediaDevices extends EventTarget {
  calls: { deviceId: string; audio: MediaTrackConstraints }[] = []
  streams: FakeStream[] = []
  devices: FakeDeviceInfo[] = [
    { deviceId: 'default', label: 'Default - Built-in Mic', kind: 'audioinput' },
    { deviceId: 'communications', label: 'Communications - Built-in Mic', kind: 'audioinput' },
    { deviceId: 'mic-a', label: 'Built-in Mic', kind: 'audioinput' },
    { deviceId: 'mic-b', label: 'USB Headset', kind: 'audioinput' },
    { deviceId: 'spk', label: 'Speakers', kind: 'audiooutput' },
  ]
  defaultLabel = 'Default - Built-in Mic'
  /** deviceId ('' = default) -> DOMException name to throw. */
  failures = new Map<string, string>()
  private gates = new Map<string, Promise<void>>()
  private releases = new Map<string, () => void>()

  /** Make the next getUserMedia for this device wait until release(deviceId) is called. */
  hold(deviceId: string) {
    this.gates.set(
      deviceId,
      new Promise<void>((resolve) => this.releases.set(deviceId, resolve)),
    )
  }
  release(deviceId: string) {
    this.releases.get(deviceId)?.()
  }

  async getUserMedia(constraints: MediaStreamConstraints) {
    const audio = constraints.audio as MediaTrackConstraints
    const exact = (audio.deviceId as ConstrainDOMStringParameters | undefined)?.exact
    const deviceId = typeof exact === 'string' ? exact : ''
    this.calls.push({ deviceId, audio })

    const gate = this.gates.get(deviceId)
    if (gate) {
      this.gates.delete(deviceId)
      await gate
    }
    const failure = this.failures.get(deviceId)
    if (failure) throw Object.assign(new Error(failure), { name: failure })

    const label = deviceId ? (this.devices.find((d) => d.deviceId === deviceId)?.label ?? deviceId) : this.defaultLabel
    const stream = new FakeStream(new FakeTrack(label, deviceId))
    this.streams.push(stream)
    return stream as unknown as MediaStream
  }

  async enumerateDevices() {
    return this.devices as unknown as MediaDeviceInfo[]
  }

  asDeps(): MicMediaDevices {
    return this as unknown as MicMediaDevices
  }

  /** Streams whose track has not been stopped. */
  liveStreams() {
    return this.streams.filter((s) => !s.track.stopped)
  }
}

export class FakeNode {
  constructor(
    readonly name: string,
    private readonly log: string[],
  ) {}
  connect(to: { name: string }) {
    this.log.push(`connect ${this.name} -> ${to.name}`)
    return to
  }
  disconnect() {
    this.log.push(`disconnect ${this.name}`)
  }
}

export class FakeAnalyser extends FakeNode {
  fftSize = 1024
  /** Constant sample value the analyser reports; set to 0 for silence. */
  amplitude = 0
  getFloatTimeDomainData(buf: Float32Array) {
    buf.fill(this.amplitude)
  }
}

export class FakeAudioContext {
  state: 'running' | 'suspended' = 'running'
  log: string[] = []
  analyser: FakeAnalyser | null = null
  readonly output = new FakeNode('worklet', this.log)

  async resume() {
    this.state = 'running'
  }
  createMediaStreamSource(stream: FakeStream) {
    return new FakeNode(`source(${stream.track.label})`, this.log)
  }
  createAnalyser() {
    this.analyser = new FakeAnalyser('analyser', this.log)
    return this.analyser
  }
  asCtx() {
    return this as unknown as AudioContext
  }
}
