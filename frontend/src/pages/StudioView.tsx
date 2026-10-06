import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { SessionStats } from '../api/types'
import { describeError } from '../api/client'
import { Banner } from '../components/Banner'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { TrackStateChip } from '../components/TrackState'
import type { LiveStatus } from '../live'
import { copyText } from '../lib/clipboard'
import { languageName } from '../lib/languages'
import { formatElapsed, formatLatency, latencyFill, latencyLevel } from '../lib/time'
import { useNow } from '../lib/useNow'

export interface StudioViewProps {
  title: string
  code: string
  startedAt: number
  sourceLang: string
  stats: SessionStats | null
  statsConnected: boolean
  liveStatus: LiveStatus
  original: string
  translated: Record<string, string>
  /** Why the mic isn't streaming, if it isn't. */
  micError: string | null
  /** The browser needs a tap before it will start the mic. */
  needsTap: boolean
  onResumeMic: () => void
  onRetry: (lang: string) => void
  onEnd: () => Promise<void>
}

/** Wireframe 3. Pure view: every state can be rendered from props. */
export function StudioView(p: StudioViewProps) {
  const now = useNow()
  const [captionLang, setCaptionLang] = useState<string | null>(null)
  const [copied, setCopied] = useState<'code' | 'link' | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [ending, setEnding] = useState(false)
  const [endError, setEndError] = useState<string | null>(null)

  const tracks = p.stats?.tracks ?? []
  const listeners = p.stats?.listeners ?? 0
  const latency = p.stats?.latencyMs ?? null
  const level = latency === null ? 'good' : latencyLevel(latency)
  const activeLang = captionLang && tracks.some((t) => t.lang === captionLang) ? captionLang : tracks[0]?.lang

  const joinUrl = `${window.location.origin}/j/${p.code}`
  const flash = (what: 'code' | 'link') => {
    setCopied(what)
    setTimeout(() => setCopied(null), 1800)
  }

  const shareLink = async () => {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: p.title, text: `Join "${p.title}" with code ${p.code}`, url: joinUrl })
      } catch {
        /* dismissed */
      }
    } else if (await copyText(joinUrl)) flash('link')
  }

  const confirmEnd = async () => {
    setEnding(true)
    setEndError(null)
    try {
      await p.onEnd()
    } catch (e) {
      setEndError(describeError(e, 'Couldn’t end the session. Try again.'))
      setEnding(false)
    }
  }

  return (
    <>
      <main className="page page--wide">
        <div className="studio__head">
          <h1>{p.title}</h1>
          <span className="live-badge">LIVE {formatElapsed(now - p.startedAt)}</span>
        </div>

        {!p.stats && !p.statsConnected && <Banner tone="warn">Waiting for live stats from the backend…</Banner>}
        {p.liveStatus === 'ended' && (
          <Banner tone="error">
            This session has ended. <Link to="/sessions/new">Create a new session</Link>
          </Banner>
        )}
        {p.micError && (
          <Banner tone="error">
            {p.micError}{' '}
            <button type="button" className="linklike" onClick={p.onResumeMic}>
              Try again
            </button>
          </Banner>
        )}
        {!p.micError && p.needsTap && (
          <Banner tone="warn">
            Your browser needs a tap to start the microphone.{' '}
            <button type="button" className="btn btn--primary btn--sm" onClick={p.onResumeMic}>
              Start microphone
            </button>
          </Banner>
        )}
        {p.liveStatus === 'connecting' && !p.micError && !p.needsTap && (
          <Banner busy>Connecting the microphone…</Banner>
        )}
        {p.liveStatus === 'reconnecting' && (
          <Banner tone="warn" busy>
            Connection lost, reconnecting…
          </Banner>
        )}

        <div className="studio">
          <section className="card code-card span-2" aria-label="Session code">
            <div className="muted small">Session code</div>
            <div className="code-row">
              <span className="code">{p.code}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn--outline btn--sm"
                  onClick={async () => (await copyText(p.code)) && flash('code')}
                >
                  {copied === 'code' ? 'Copied ✓' : 'Copy'}
                </button>
                <button type="button" className="btn btn--outline btn--sm" onClick={shareLink}>
                  {copied === 'link' ? 'Link copied ✓' : typeof navigator.share === 'function' ? 'Share link' : 'Copy link'}
                </button>
              </div>
            </div>
          </section>

          <section className="card listeners-card" aria-label="Total listeners">
            <div className="muted small">Total listeners</div>
            <div className="big">{listeners}</div>
          </section>

          <section className={`card latency-card latency--${level}`} aria-label="Latency">
            <div className="muted small">Latency: end of speech to translated audio</div>
            <div className="big">{latency === null ? '—' : formatLatency(latency)}</div>
            {latency !== null && (
              <>
                <div className="latency__bar" aria-hidden="true">
                  <div className="latency__fill" style={{ width: `${latencyFill(latency) * 100}%` }} />
                </div>
                <div className="latency__label">{{ good: 'Good', fair: 'Fair', slow: 'Slow' }[level]}</div>
              </>
            )}
          </section>

          <section className="card tracks-card span-2" aria-labelledby="tracks-h">
            <h2 id="tracks-h">Language tracks</h2>
            {tracks.length === 0 ? (
              <p className="muted">No tracks yet.</p>
            ) : (
              <ul className="tracks">
                {tracks.map((t) => (
                  <li key={t.lang}>
                    <span className="tracks__name">{languageName(t.lang)}</span>
                    <span>
                      <TrackStateChip state={t.state} />
                      {t.state === 'error' && (
                        <>
                          {' '}
                          <button type="button" className="linklike" onClick={() => p.onRetry(t.lang)}>
                            Retry
                          </button>
                        </>
                      )}
                    </span>
                    <span className="tracks__count" aria-label={`${t.listeners} listeners`}>
                      {t.listeners}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card captions-card span-2" aria-labelledby="captions-h">
            <div className="field-row">
              <h2 id="captions-h">Captions preview</h2>
              {tracks.length > 0 && (
                <select
                  className="select"
                  style={{ width: 'auto', minHeight: 40 }}
                  aria-label="Caption language"
                  value={activeLang}
                  onChange={(e) => setCaptionLang(e.target.value)}
                >
                  {tracks.map((t) => (
                    <option key={t.lang} value={t.lang}>
                      {languageName(t.lang)}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div>
              <div className="caption-block">
                <div className="cap-label">Original · {languageName(p.sourceLang)}</div>
                <p>{p.original || <span className="cap-empty">Waiting for the speaker…</span>}</p>
              </div>
              {activeLang && (
                <div className="caption-block">
                  <div className="cap-label">Translated · {languageName(activeLang)}</div>
                  <p style={{ fontWeight: 700 }}>
                    {p.translated[activeLang] || <span className="cap-empty">No translated captions yet.</span>}
                  </p>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      <div className="bar bar--wide">
        <div className="bar__inner">
          <p className="bar__hint">Ending the session stops all tracks and disconnects listeners.</p>
          <button type="button" className="btn btn--danger-outline" onClick={() => setConfirming(true)}>
            End session
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        title="End this session?"
        confirmLabel="End session"
        busy={ending}
        onCancel={() => {
          setConfirming(false)
          setEndError(null)
        }}
        onConfirm={confirmEnd}
      >
        {listeners} {listeners === 1 ? 'listener' : 'listeners'} will be disconnected.
        {endError && (
          <div style={{ marginTop: 12 }}>
            <Banner tone="error">{endError}</Banner>
          </div>
        )}
      </ConfirmDialog>
    </>
  )
}
