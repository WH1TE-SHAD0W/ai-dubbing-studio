// One shared AudioContext. The tap on the language/audio-check screen resumes it, which also
// satisfies mobile autoplay rules for the live view that follows in the same document.

let ctx: AudioContext | null = null

export function getAudioContext(): AudioContext {
  ctx ??= new AudioContext()
  return ctx
}

export interface TestSound {
  setVolume: (v: number) => void
  done: Promise<void>
}

const NOTES = [523.25, 659.25, 783.99] // C5 E5 G5
const NOTE_GAP = 0.28

/** A short three-note chime at `volume` (0..1); the level can be changed while it plays. */
export async function playTestChime(volume: number): Promise<TestSound> {
  const ac = getAudioContext()
  if (ac.state === 'suspended') await ac.resume()

  const gain = ac.createGain()
  gain.gain.value = volume
  gain.connect(ac.destination)

  const t0 = ac.currentTime + 0.02
  NOTES.forEach((freq, i) => {
    const osc = ac.createOscillator()
    const env = ac.createGain()
    const start = t0 + i * NOTE_GAP
    osc.frequency.value = freq
    env.gain.setValueAtTime(0, start)
    env.gain.linearRampToValueAtTime(0.6, start + 0.03)
    env.gain.exponentialRampToValueAtTime(0.001, start + 0.5)
    osc.connect(env).connect(gain)
    osc.start(start)
    osc.stop(start + 0.55)
  })

  return {
    setVolume: (v) => {
      gain.gain.value = v
    },
    done: new Promise((resolve) => setTimeout(resolve, (NOTES.length * NOTE_GAP + 0.4) * 1000)),
  }
}
