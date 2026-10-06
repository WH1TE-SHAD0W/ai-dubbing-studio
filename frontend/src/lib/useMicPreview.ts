import { useEffect, useMemo } from 'react'
import { createMicInput } from '../live/mic'
import { useLive } from '../live'
import { getAudioContext } from './audio'

/**
 * A meter-only microphone check for the Create-session screen. Nothing is requested until start()
 * is called from a tap, and the device is released when the screen goes away, before the studio opens it.
 */
export function useMicPreview() {
  const mic = useMemo(() => createMicInput({ ctxFactory: getAudioContext }), [])
  const state = useLive(mic.state)

  useEffect(() => () => mic.stop(), [mic])

  return {
    state,
    level: mic.level,
    start: () => {
      void getAudioContext().resume() // we're inside a tap, so the browser allows it
      return mic.start()
    },
    select: (choice: string) => void mic.select(choice),
    stop: () => mic.stop(),
  }
}
