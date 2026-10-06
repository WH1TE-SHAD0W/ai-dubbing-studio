import { useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { describeError } from '../api/client'
import type { JoinInfo } from '../api/types'
import { AppBar } from '../components/AppBar'
import { Banner } from '../components/Banner'
import { playTestChime, type TestSound } from '../lib/audio'
import { languageName } from '../lib/languages'
import { load, save } from '../lib/storage'
import { useJoinInfo } from './useJoinInfo'

export const listenerKey = (code: string) => `ads.listener.${code}`

export function ListenSetupPage() {
  const { code = '' } = useParams()
  const [retry, setRetry] = useState(0)
  const info = useJoinInfo(code, retry)

  return (
    <>
      <AppBar />
      {info.status === 'loading' && (
        <main className="page">
          <div className="center-state" role="status">
            <span className="spinner" aria-hidden="true" /> Checking the room…
          </div>
        </main>
      )}
      {info.status === 'error' && (
        <main className="page">
          <Banner tone="error">{describeError(info.error, 'That session isn’t available.')}</Banner>
          <button type="button" className="btn btn--outline" onClick={() => setRetry((n) => n + 1)}>
            Try again
          </button>
          <Link to="/join">Enter a different code</Link>
        </main>
      )}
      {info.status === 'ok' && <SetupForm code={code} info={info.data} />}
    </>
  )
}

export function SetupForm({ code, info }: { code: string; info: JoinInfo }) {
  const navigate = useNavigate()
  const [lang, setLang] = useState(() => {
    const saved = load<{ lang: string }>(listenerKey(code))?.lang
    return saved && info.languages.includes(saved) ? saved : info.languages[0]
  })
  const [volume, setVolume] = useState(() => load<number>('ads.volume') ?? 0.7)
  const [playing, setPlaying] = useState(false)
  const [played, setPlayed] = useState(false)
  const [heard, setHeard] = useState(false)
  const [audioError, setAudioError] = useState(false)
  const sound = useRef<TestSound | null>(null)

  const play = async () => {
    setAudioError(false)
    setPlaying(true)
    try {
      const s = await playTestChime(volume)
      sound.current = s
      setPlayed(true)
      await s.done
    } catch {
      setAudioError(true)
    } finally {
      sound.current = null
      setPlaying(false)
    }
  }

  const enter = () => {
    save(listenerKey(code), { lang })
    save('ads.volume', volume)
    navigate(`/listen/${code}`, { state: { info } })
  }

  return (
    <>
      <main className="page">
        <div>
          <h1>Check your audio</h1>
          <p className="muted">
            {info.title} · {info.speakerName}
          </p>
        </div>

        <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <legend className="label" style={{ padding: 0, marginBottom: 8 }}>
            Listening language
          </legend>
          {info.languages.map((l) => (
            <label key={l} className="choice">
              <input type="radio" name="lang" value={l} checked={lang === l} onChange={() => setLang(l)} />
              {languageName(l)}
            </label>
          ))}
        </fieldset>

        <section className="field" aria-labelledby="test-label">
          <span id="test-label" className="label">
            Test sound
          </span>
          <button type="button" className="btn btn--outline btn--block" onClick={play} disabled={playing}>
            <span aria-hidden="true">▶</span> {playing ? 'Playing…' : 'Play test sound'}
          </button>
          {audioError && <Banner tone="error">Couldn’t play audio. Check that your device isn’t muted.</Banner>}
          <div className="range">
            <label htmlFor="vol" className="label">
              Volume
            </label>
            <input
              id="vol"
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(volume * 100)}
              onChange={(e) => {
                const v = Number(e.target.value) / 100
                setVolume(v)
                sound.current?.setVolume(v)
              }}
            />
            <output htmlFor="vol">{Math.round(volume * 100)}%</output>
          </div>
        </section>

        <label className="check-card" style={played ? undefined : { opacity: 0.6, cursor: 'not-allowed' }}>
          <input type="checkbox" checked={heard} disabled={!played} onChange={(e) => setHeard(e.target.checked)} />
          I can hear the test sound
        </label>

        {heard && (
          <Banner>
            <strong>✓ Audio is working</strong>
          </Banner>
        )}

        <p className="muted small">Translated audio is AI-generated.</p>
      </main>

      <div className="bar">
        <div className="bar__inner">
          <button type="button" className="btn btn--primary btn--block" disabled={!heard} onClick={enter}>
            Enter session
          </button>
        </div>
      </div>
    </>
  )
}
