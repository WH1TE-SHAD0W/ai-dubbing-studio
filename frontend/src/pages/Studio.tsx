import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, describeError } from '../api/client'
import { useSessionStats } from '../api/stats'
import type { StartedSession } from '../api/types'
import { Banner } from '../components/Banner'
import { HostBar } from '../components/HostBar'
import { createHostLive, useLive } from '../live'
import { useAsync } from '../lib/useAsync'
import { useWakeLock } from '../lib/useWakeLock'
import { StudioView } from './StudioView'

export function StudioPage() {
  const { id = '' } = useParams()
  const [retry, setRetry] = useState(0)
  // start is idempotent on the backend, so a refresh (or StrictMode's double effect) is harmless.
  const started = useAsync(() => api.startSession(id), [id], retry)

  return (
    <>
      <HostBar />
      {started.status === 'loading' && (
        <main className="page">
          <div className="center-state" role="status">
            <span className="spinner" aria-hidden="true" /> Starting session…
          </div>
        </main>
      )}
      {started.status === 'error' && (
        <main className="page">
          <Banner tone="error">{describeError(started.error, 'Couldn’t start the session.')}</Banner>
          <button type="button" className="btn btn--outline" onClick={() => setRetry((n) => n + 1)}>
            Try again
          </button>
          <Link to="/sessions/new">Back to create session</Link>
        </main>
      )}
      {started.status === 'ok' && <LiveStudio session={started.data} />}
    </>
  )
}

function LiveStudio({ session }: { session: StartedSession }) {
  const navigate = useNavigate()
  const { stats, connected } = useSessionStats(session.id)
  const host = useMemo(createHostLive, [])
  const live = useLive(host)

  useEffect(() => {
    host.connect(session.id)
    return () => host.disconnect()
  }, [host, session.id])

  useWakeLock(true)

  return (
    <StudioView
      title={session.title}
      code={session.joinCode}
      startedAt={session.startedAt}
      sourceLang={session.sourceLang}
      stats={stats}
      statsConnected={connected}
      liveStatus={live.status}
      original={live.original}
      translated={live.translated}
      micError={live.error}
      needsTap={live.needsTap}
      onResumeMic={() => host.resume()}
      onRetry={(lang) => void api.retryTrack(session.id, lang).catch(() => {})}
      onEnd={async () => {
        await api.endSession(session.id)
        navigate('/sessions/new', { replace: true })
      }}
    />
  )
}
