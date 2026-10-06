import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { describeError } from '../api/client'
import { AppBar } from '../components/AppBar'
import { Banner } from '../components/Banner'
import { createListenerLive, useLive } from '../live'
import { load, save } from '../lib/storage'
import { useMediaSession } from '../lib/useMediaSession'
import { useWakeLock } from '../lib/useWakeLock'
import { ListenLiveView } from './ListenLiveView'
import { listenerKey } from './ListenSetup'
import { useJoinInfo } from './useJoinInfo'

export function ListenLivePage() {
  const { code = '' } = useParams()
  const info = useJoinInfo(code)
  const savedLang = load<{ lang: string }>(listenerKey(code))?.lang

  // No stored language (first visit, cleared storage): go through the audio check, which also gives the tap that unlocks audio.
  if (!savedLang) return <Navigate to={`/listen/${code}/setup`} replace />

  if (info.status === 'loading')
    return (
      <>
        <AppBar />
        <main className="page">
          <div className="center-state" role="status">
            <span className="spinner" aria-hidden="true" /> Joining…
          </div>
        </main>
      </>
    )

  if (info.status === 'error')
    return (
      <>
        <AppBar />
        <main className="page">
          <Banner tone="error">{describeError(info.error, 'That session isn’t available.')}</Banner>
          <Link to="/join">Enter a different code</Link>
        </main>
      </>
    )

  return (
    <LiveSession
      code={code}
      initialLang={info.data.languages.includes(savedLang) ? savedLang : info.data.languages[0]}
      title={info.data.title}
      speakerName={info.data.speakerName}
      sourceLang={info.data.sourceLang}
      languages={info.data.languages}
    />
  )
}

interface SessionProps {
  code: string
  initialLang: string
  title: string
  speakerName: string
  sourceLang: string
  languages: string[]
}

function LiveSession({ code, initialLang, title, speakerName, sourceLang, languages }: SessionProps) {
  const listener = useMemo(createListenerLive, [])
  const state = useLive(listener)
  const [lang, setLang] = useState(initialLang)
  const [volume, setVolume] = useState(() => load<number>('ads.volume') ?? 0.7)
  const [muted, setMuted] = useState(false)

  useEffect(() => {
    listener.connect(code, initialLang)
    return () => listener.disconnect()
  }, [listener, code, initialLang])

  useEffect(() => listener.setVolume(volume), [listener, volume])
  useEffect(() => listener.setMuted(muted), [listener, muted])

  useWakeLock(state.status !== 'ended')
  useMediaSession(title, muted, setMuted)

  const changeLang = useCallback(
    (l: string) => {
      setLang(l)
      save(listenerKey(code), { lang: l })
      listener.setLanguage(l)
    },
    [code, listener],
  )

  return (
    <ListenLiveView
      title={title}
      speakerName={speakerName}
      sourceLang={sourceLang}
      languages={languages}
      lang={lang}
      onLang={changeLang}
      state={state}
      volume={volume}
      onVolume={(v) => {
        setVolume(v)
        save('ads.volume', v)
      }}
      muted={muted}
      onMuted={setMuted}
      onResume={() => listener.resumeAudio()}
    />
  )
}
