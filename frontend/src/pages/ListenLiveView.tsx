import { Link } from 'react-router-dom'
import { Banner } from '../components/Banner'
import type { ListenerLiveState } from '../live'
import { languageName } from '../lib/languages'

export interface ListenLiveViewProps {
  title: string
  speakerName: string
  sourceLang: string
  languages: string[]
  lang: string
  onLang: (lang: string) => void
  state: ListenerLiveState
  volume: number // 0..1
  onVolume: (v: number) => void
  muted: boolean
  onMuted: (m: boolean) => void
  onResume: () => void
}

/** Wireframe 6. Pure view: every state can be rendered from props. */
export function ListenLiveView(p: ListenLiveViewProps) {
  const { state } = p

  if (state.status === 'ended') {
    return (
      <div className="live">
        <div className="live__body">
          <div className="center-state" role="status">
            <h1>The session has ended</h1>
            <p className="muted">{p.title}</p>
            <Link to="/join" className="btn btn--primary">
              Join another session
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const speaking = state.speaker.speaking
  const name = state.speaker.name || p.speakerName

  return (
    <div className="live">
      <header className="live__head">
        <h1>{p.title}</h1>
        <span className="live-badge">LIVE</span>
      </header>

      <div className="live__body">
        {state.status === 'reconnecting' && (
          <Banner tone="warn" busy>
            Connection lost, reconnecting…
          </Banner>
        )}
        {state.trackDown && (
          <Banner tone="warn" busy>
            The {languageName(p.lang)} translation was interrupted and is restarting…
          </Banner>
        )}

        <section className="speaker" aria-label="Speaker">
          <div className="speaker__avatar" aria-hidden="true" />
          <div className="speaker__info">
            <div className="speaker__name">{name}</div>
            <div className="muted small">
              <span className={`speaking${speaking ? ' speaking--on' : ''}`} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {speaking ? 'Speaking' : 'Silent'}
            </div>
          </div>
          <span className="ai-tag">AI voice</span>
        </section>

        <div className="lang-switch">
          <span className="muted small" id="listen-in">
            Listening in
          </span>
          <div className="chips" role="group" aria-labelledby="listen-in">
            {p.languages.map((l) => (
              <button
                key={l}
                type="button"
                className="chip"
                aria-pressed={p.lang === l}
                onClick={() => p.onLang(l)}
              >
                {languageName(l)}
              </button>
            ))}
          </div>
        </div>

        <section className="cap-card" aria-label="Original captions">
          <div className="cap-label">Original · {languageName(p.sourceLang)}</div>
          <p className="cap-orig">{state.original || <span className="cap-empty">Waiting for the speaker…</span>}</p>
        </section>

        <section className="cap-card cap-card--main" aria-label="Translated captions">
          <div className="cap-label">Translated · {languageName(p.lang)}</div>
          <p className="cap-trans" role="log" aria-live="polite">
            {state.translated || <span className="cap-empty">Translated captions will appear here.</span>}
          </p>
        </section>
      </div>

      <div className="bar">
        <div className="bar__inner">
          <div className="range" style={{ flex: 1 }}>
            <label htmlFor="live-vol" className="label">
              Volume
            </label>
            <input
              id="live-vol"
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(p.volume * 100)}
              onChange={(e) => p.onVolume(Number(e.target.value) / 100)}
            />
          </div>
          <button
            type="button"
            className="btn btn--ghost"
            aria-pressed={p.muted}
            onClick={() => p.onMuted(!p.muted)}
          >
            {p.muted ? 'Unmute' : 'Mute'}
          </button>
        </div>
      </div>

      {state.audioBlocked && (
        <div className="overlay">
          <div className="overlay__card" role="dialog" aria-modal="true" aria-labelledby="resume-title">
            <h2 id="resume-title">Audio is paused</h2>
            <p className="muted">Your browser needs a tap before it plays sound.</p>
            <button type="button" className="btn btn--primary" onClick={p.onResume} autoFocus>
              Tap to resume audio
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
