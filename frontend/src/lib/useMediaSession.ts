import { useEffect } from 'react'

/** Lock-screen / notification controls: pause and play map to mute and unmute. */
export function useMediaSession(title: string, muted: boolean, setMuted: (m: boolean) => void): void {
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    ms.metadata = new MediaMetadata({
      title,
      artist: 'AI voice',
      album: 'AI Dubbing Studio',
      artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
    })
    ms.setActionHandler('pause', () => setMuted(true))
    ms.setActionHandler('play', () => setMuted(false))
    return () => {
      ms.setActionHandler('pause', null)
      ms.setActionHandler('play', null)
      ms.metadata = null
    }
  }, [title, setMuted])

  useEffect(() => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = muted ? 'paused' : 'playing'
  }, [muted])
}
