// Development-only harness (see App.tsx). Renders the presentational views with the wireframes'
// sample data so the screens that depend on the backend can be inspected in every state.
// It is not a demo mode and is not part of production builds.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { SessionStats } from '../api/types'
import { AppBar } from '../components/AppBar'
import { createStore, type ListenerLiveState, type LiveStatus } from '../live'
import { idleMicState, type MicState } from '../live/mic'
import { ListenLiveView } from './ListenLiveView'
import { SetupForm } from './ListenSetup'
import { StudioView } from './StudioView'

const stats: SessionStats = {
  listeners: 33,
  latencyMs: 1400,
  tracks: [
    { lang: 'sk', state: 'live', listeners: 21 },
    { lang: 'de', state: 'live', listeners: 12 },
    { lang: 'es', state: 'starting', listeners: 0 },
    { lang: 'fr', state: 'error', listeners: 0 },
  ],
}

const original = 'So the main question is whether intentions matter more than outcomes.'
const translated = {
  sk: 'Takže hlavná otázka je, či zámery majú väčší význam ako výsledky.',
  de: 'Die Hauptfrage lautet also, ob Absichten wichtiger sind als Ergebnisse.',
}

const live = (patch: Partial<ListenerLiveState> = {}): ListenerLiveState => ({
  status: 'live',
  speaker: { name: 'Dr. Novak', speaking: true },
  original,
  translated: translated.sk,
  audioBlocked: false,
  trackDown: false,
  ...patch,
})

const info = {
  title: 'Ethics 101, Lecture 4',
  speakerName: 'Dr. Novak',
  sourceLang: 'en',
  languages: ['sk', 'de', 'es', 'fr'],
}

const micOn: MicState = {
  ...idleMicState,
  status: 'on',
  activeLabel: 'Built-in Microphone',
  devices: [
    { id: 'a', label: 'Built-in Microphone' },
    { id: 'b', label: 'USB Headset' },
    { id: 'c', label: 'Bluetooth Earbuds' },
  ],
  heard: true,
}

/** A level that moves like speech, so the meter can be judged by eye. `base` of 0 holds it at silence. */
function useFakeLevel(base: number) {
  const store = useMemo(() => createStore({ level: 0 }), [])
  useEffect(() => {
    if (base === 0) return
    const t = setInterval(() => store.setState({ level: Math.min(1, Math.max(0.05, base + (Math.random() - 0.5) * 0.5)) }), 100)
    return () => clearInterval(t)
  }, [base, store])
  return store
}

function StudioScenario({
  stats: s,
  liveStatus = 'live',
  micError = null,
  needsTap = false,
  mic = micOn,
  levelBase = 0.6,
}: {
  stats: SessionStats | null
  liveStatus?: LiveStatus
  micError?: string | null
  needsTap?: boolean
  mic?: MicState
  levelBase?: number
}) {
  const micLevel = useFakeLevel(levelBase)
  const [choice, setChoice] = useState(mic.choice)
  const [processing, setProcessing] = useState(mic.processing)
  return (
    <StudioView
      title="Ethics 101, Lecture 4"
      code="KX74M2"
      startedAt={Date.now() - (42 * 60 + 17) * 1000}
      sourceLang="en"
      stats={s}
      statsConnected={s !== null}
      liveStatus={liveStatus}
      original={original}
      translated={translated}
      micError={micError}
      needsTap={needsTap}
      onResumeMic={() => {}}
      mic={{ ...mic, choice, processing }}
      micLevel={micLevel}
      onSelectMic={setChoice}
      onMicProcessing={setProcessing}
      onRetry={() => {}}
      onEnd={() => new Promise((r) => setTimeout(r, 800))}
    />
  )
}

function ListenScenario({ state }: { state: ListenerLiveState }) {
  const [lang, setLang] = useState('sk')
  const [volume, setVolume] = useState(0.7)
  const [muted, setMuted] = useState(false)
  return (
    <ListenLiveView
      {...info}
      lang={lang}
      onLang={setLang}
      state={state}
      volume={volume}
      onVolume={setVolume}
      muted={muted}
      onMuted={setMuted}
      onResume={() => {}}
    />
  )
}

const SCENARIOS: Record<string, () => ReactNode> = {
  'studio-live': () => <StudioScenario stats={stats} />,
  'studio-waiting': () => <StudioScenario stats={null} liveStatus="connecting" />,
  'studio-mic-blocked': () => (
    <StudioScenario
      stats={stats}
      liveStatus="unavailable"
      micError="Microphone access was blocked. Allow it in your browser, then try again."
    />
  ),
  'studio-mic-switching': () => <StudioScenario stats={stats} mic={{ ...micOn, switching: true }} />,
  'studio-mic-notice': () => (
    <StudioScenario
      stats={stats}
      mic={{ ...micOn, notice: 'Microphone disconnected, switched to the system default.' }}
    />
  ),
  'studio-mic-silent': () => <StudioScenario stats={stats} mic={{ ...micOn, heard: false, silent: true }} levelBase={0} />,
  'studio-mic-lost': () => (
    <StudioScenario
      stats={stats}
      micError="The microphone was disconnected and no other input is available. Plug one in and try again."
      mic={{ ...micOn, status: 'lost', activeLabel: null }}
      levelBase={0}
    />
  ),
  'studio-needs-tap': () => <StudioScenario stats={stats} liveStatus="connecting" needsTap />,
  'studio-reconnecting': () => <StudioScenario stats={stats} liveStatus="reconnecting" />,
  'studio-ended': () => <StudioScenario stats={stats} liveStatus="ended" />,
  'listen-setup': () => (
    <>
      <AppBar />
      <SetupForm code="KX74M2" info={info} />
    </>
  ),
  'listen-live': () => <ListenScenario state={live()} />,
  'listen-reconnecting': () => <ListenScenario state={live({ status: 'reconnecting' })} />,
  'listen-audio-blocked': () => <ListenScenario state={live({ audioBlocked: true })} />,
  'listen-track-down': () => <ListenScenario state={live({ trackDown: true })} />,
  'listen-ended': () => <ListenScenario state={live({ status: 'ended' })} />,
}

export default function DevPreview() {
  const [params, setParams] = useSearchParams()
  const current = params.get('s') ?? 'studio-live'
  const render = SCENARIOS[current] ?? SCENARIOS['studio-live']

  return (
    <>
      <nav style={{ padding: 8, background: '#222', color: '#fff', display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong>Dev preview</strong>
        <select
          aria-label="Scenario"
          value={current}
          onChange={(e) => setParams({ s: e.target.value })}
          style={{ minHeight: 32, color: '#000' }}
        >
          {Object.keys(SCENARIOS).map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </nav>
      {/* key remounts the scenario so each one starts from fresh state */}
      <div key={current} style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {render()}
      </div>
    </>
  )
}
