import { useEffect, useState } from 'react'
import type { SessionStats } from './types'

/** Live stats for the control room over Server-Sent Events. EventSource reconnects on its own. */
export function useSessionStats(sessionId: string | null): { stats: SessionStats | null; connected: boolean } {
  const [stats, setStats] = useState<SessionStats | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!sessionId) return
    const es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/stats`)
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (e) => {
      try {
        setStats(JSON.parse(e.data) as SessionStats)
        setConnected(true)
      } catch {
        /* ignore malformed frames */
      }
    }
    return () => es.close()
  }, [sessionId])

  return { stats, connected }
}
