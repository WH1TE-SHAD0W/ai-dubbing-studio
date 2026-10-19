import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, describeError } from '../api/client'
import { CONSENT_TEXT_VERSION } from '../api/types'
import { Banner } from '../components/Banner'
import { HostBar } from '../components/HostBar'
import { MicPicker, silentHint } from '../components/MicPicker'
import { LANGUAGES, MAX_TARGETS, toggleTarget, visibleTargets, withoutSpoken } from '../lib/languages'
import { canStart, startBlockers, type SessionForm } from '../lib/sessionForm'
import { useMicPreview } from '../lib/useMicPreview'

export function CreateSessionPage() {
  const navigate = useNavigate()
  const micTest = useMicPreview()

  const [title, setTitle] = useState('')
  const [sourceLang, setSourceLang] = useState('en')
  const [targets, setTargets] = useState<string[]>([])
  const [expanded, setExpanded] = useState(false)
  const [speakerConsent, setSpeakerConsent] = useState(false)
  const [aiNotice, setAiNotice] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const form: SessionForm = { title, targets, speakerConsent, aiNotice }
  const blockers = startBlockers(form)
  const atMax = targets.length >= MAX_TARGETS

  const reset = () => {
    setTitle('')
    setTargets([])
    setSpeakerConsent(false)
    setAiNotice(false)
    setError(null)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!canStart(form) || busy) return
    setBusy(true)
    setError(null)
    try {
      const session = await api.createSession({
        title: title.trim(),
        sourceLang,
        targetLangs: targets,
        consent: { speaker: true, aiNotice: true, textVersion: CONSENT_TEXT_VERSION },
      })
      navigate(`/studio/${session.id}`)
    } catch (err) {
      setError(describeError(err, 'Couldn’t create the session. Try again.'))
      setBusy(false)
    }
  }

  return (
    <>
      <HostBar />
      <form className="form-fill" onSubmit={submit} noValidate>
        <main className="page page--wide">
          <h1>Create session</h1>

          {error && <Banner tone="error">{error}</Banner>}

          <div className="grid-2">
            <section className="card" aria-labelledby="session-h">
              <h2 id="session-h">Session</h2>

              <div className="field">
                <label className="label" htmlFor="title">
                  Session title
                </label>
                <input
                  id="title"
                  className="input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Ethics 101, Lecture 4"
                  autoComplete="off"
                  maxLength={120}
                />
              </div>

              <div className="field">
                <label className="label" htmlFor="source">
                  Spoken language <small>(select one)</small>
                </label>
                <select
                  id="source"
                  className="select"
                  value={sourceLang}
                  onChange={(e) => {
                    setSourceLang(e.target.value)
                    setTargets((t) => withoutSpoken(t, e.target.value))
                  }}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>

              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="label" style={{ padding: 0, marginBottom: 8 }}>
                  Target languages <small>(select one or more, up to {MAX_TARGETS})</small>
                </legend>
                <div className="chips">
                  {visibleTargets(sourceLang, targets, expanded).map((l) => {
                    const on = targets.includes(l.code)
                    return (
                      <button
                        key={l.code}
                        type="button"
                        className="chip"
                        aria-pressed={on}
                        aria-disabled={!on && atMax}
                        onClick={() => setTargets((t) => toggleTarget(t, l.code))}
                      >
                        {on && <span aria-hidden="true">✓ </span>}
                        {l.name}
                      </button>
                    )
                  })}
                  {!expanded && (
                    <button type="button" className="chip chip--more" onClick={() => setExpanded(true)}>
                      + More
                    </button>
                  )}
                </div>
              </fieldset>
            </section>

            <section className="card" aria-labelledby="voice-h">
              <h2 id="voice-h">Speaker voice</h2>
              <p className="muted">
                The translated voice is matched automatically from the speaker’s live audio, so no recording is
                needed. Audio is passed straight through and never stored.
              </p>

              <MicTest test={micTest} />

              <label className="check-card">
                <input
                  type="checkbox"
                  checked={speakerConsent}
                  onChange={(e) => setSpeakerConsent(e.target.checked)}
                />
                The speaker agrees to have their voice cloned
              </label>
              <label className="check-card">
                <input type="checkbox" checked={aiNotice} onChange={(e) => setAiNotice(e.target.checked)} />
                Listeners are told the audio is AI-generated.
              </label>
            </section>
          </div>
        </main>

        <div className="bar bar--wide">
          <div className="bar__inner">
            <p className="bar__hint" aria-live="polite">
              {blockers[0] ?? 'Ready to start.'}
            </p>
            <button type="button" className="btn btn--ghost" onClick={reset} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={blockers.length > 0 || busy}>
              {busy ? 'Starting…' : 'Start session'}
            </button>
          </div>
        </div>
      </form>
    </>
  )
}

type MicTestState = ReturnType<typeof useMicPreview>

/** Optional "check your microphone" step. Nothing is requested until the host taps the button. */
function MicTest({ test }: { test: MicTestState }) {
  const { state } = test
  const running = state.status === 'on'

  return (
    <div className="field" aria-labelledby="mic-test-h">
      <span id="mic-test-h" className="label">
        Microphone <small>(optional check)</small>
      </span>

      {!running && state.status !== 'starting' && (
        <>
          <p className="muted small">Pick your input and watch the level before you go live.</p>
          <div>
            <button type="button" className="btn btn--outline btn--sm" onClick={() => void test.start()}>
              Test microphone
            </button>
          </div>
        </>
      )}
      {state.status === 'starting' && (
        <p className="muted small" role="status">
          Waiting for microphone access…
        </p>
      )}
      {state.error && <Banner tone="error">{state.error}</Banner>}

      {running && (
        <>
          <MicPicker
            id="mic-test-select"
            mic={state}
            level={test.level}
            onSelect={test.select}
            onProcessing={test.setProcessing}
            hint={
              state.silent
                ? silentHint(state)
                : state.heard
                  ? 'We can hear you ✓'
                  : 'Say something to test.'
            }
          />
          <div>
            <button type="button" className="linklike" onClick={test.stop}>
              Stop test
            </button>
          </div>
        </>
      )}
    </div>
  )
}
