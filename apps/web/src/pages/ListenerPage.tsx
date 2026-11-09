import { type JoinSessionResponse, type LanguageCode, type ListenerTokenResponse, languageName } from "@ads/contracts";
import { Link, getRouteApi } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { Layout } from "../components/Layout.tsx";
import { useMediaSession } from "../features/listen/useMediaSession.ts";
import { ApiError, api } from "../lib/api.ts";
import { useAsync } from "../lib/useAsync.ts";

const route = getRouteApi("/listen/$code");

// LiveKit is most of the bundle, so it only loads once a listener starts listening.
const ListenerAudio = lazy(() => import("../features/listen/ListenerAudio.tsx").then((m) => ({ default: m.ListenerAudio })));

// How often to check again while the host hasn't gone live yet.
const WAITING_POLL_MS = 10_000;

export function ListenerPage() {
  const { code } = route.useParams();
  const join = useAsync(() => api.getJoin(code), [code]);
  const waiting = join.status === "ready" && join.data.status === "draft";

  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(join.reload, WAITING_POLL_MS);
    return () => clearInterval(t);
  }, [waiting, join.reload]);

  return (
    <Layout>
      {join.status === "loading" && <p className="hint">Finding the session…</p>}
      {join.status === "error" && <JoinError error={join.error} retry={join.reload} />}
      {join.status === "ready" && join.data.status === "draft" && (
        <Notice title={join.data.title} text="The session hasn't started yet. This page checks again every few seconds." />
      )}
      {join.status === "ready" && join.data.status === "ended" && (
        <Notice title={join.data.title} text="This session has ended. Thanks for listening." />
      )}
      {join.status === "ready" && join.data.status === "live" && <LiveListener code={code} session={join.data} />}
    </Layout>
  );
}

function pickDefault(languages: readonly LanguageCode[]): LanguageCode {
  const preferred = navigator.languages.map((l) => l.slice(0, 2).toLowerCase());
  return languages.find((l) => preferred.includes(l)) ?? languages[0]!;
}

function LiveListener({ code, session }: { code: string; session: JoinSessionResponse }) {
  const [lang, setLang] = useState<LanguageCode>(() => pickDefault(session.languages));
  const [connection, setConnection] = useState<ListenerTokenResponse | null>(null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The host ended the session while this listener was connected.
  const [ended, setEnded] = useState(false);
  // Kept here, so they stay the same when the listener switches language.
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  // Each language has its own LiveKit room, so switching fetches a new token.
  const connect = useCallback(
    async (to: LanguageCode) => {
      setError(null);
      setConnection(null);
      try {
        setConnection(await api.getListenerToken(code, to));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't join the audio.");
        setListening(false);
      }
    },
    [code],
  );

  function start() {
    setListening(true);
    void connect(lang);
  }

  const stop = useCallback(() => {
    setListening(false);
    setConnection(null);
  }, []);

  function changeLang(to: LanguageCode) {
    setLang(to);
    if (listening) void connect(to);
  }

  const end = useCallback(() => {
    setEnded(true);
    setListening(false);
    setConnection(null);
  }, []);

  if (ended) return <Notice title={session.title} text="This session has ended. Thanks for listening." />;

  return (
    <div className="stack">
      <section className="card stack">
        <h1>{session.title}</h1>
        <p className="hint">
          {session.hostName} · speaking {languageName(session.sourceLang)}
        </p>

        <div className="field">
          <span id="lang-label">Your language</span>
          <div className="chips" role="group" aria-labelledby="lang-label">
            {session.languages.map((l) => (
              <button key={l} type="button" className={`chip ${l === lang ? "chip-on" : ""}`} aria-pressed={l === lang} onClick={() => changeLang(l)}>
                {languageName(l)}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="error" role="alert">{error}</p>}

        {listening ? (
          <>
            <Suspense fallback={<p className="hint">Joining…</p>}>
              {connection ? (
                <ListenerAudio key={connection.token} connection={connection} volume={volume} muted={muted} onEnded={end} />
              ) : (
                <p className="hint">Joining…</p>
              )}
            </Suspense>
            <div className="row wrap">
              <button type="button" className="secondary" aria-pressed={muted} onClick={() => setMuted((m) => !m)}>
                {muted ? "Unmute" : "Mute"}
              </button>
              <label className="row">
                Volume
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                />
              </label>
            </div>
            <MediaSession title={session.title} lang={lang} onStop={stop} />
            <button type="button" className="secondary" onClick={stop}>
              Stop listening
            </button>
          </>
        ) : (
          <button type="button" className="primary" onClick={start}>
            Start listening
          </button>
        )}
        <p className="hint">The translated audio is AI-generated in the speaker's voice.</p>
      </section>

      <section className="card" aria-labelledby="captions-heading">
        <h2 id="captions-heading">Captions</h2>
        <p className="hint">Captions are coming: how they reach the app is still to be decided.</p>
      </section>
    </div>
  );
}

function MediaSession({ title, lang, onStop }: { title: string; lang: LanguageCode; onStop: () => void }) {
  useMediaSession(title, languageName(lang), onStop);
  return null;
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <section className="card stack">
      <h1>{title}</h1>
      <p role="status">{text}</p>
    </section>
  );
}

function JoinError({ error, retry }: { error: Error; retry: () => void }) {
  const notFound = error instanceof ApiError && error.status === 404;
  return (
    <section className="card stack">
      <h1>{notFound ? "Session not found" : "Couldn't load the session"}</h1>
      <p className="error" role="alert">
        {notFound ? "No session uses this code. Check it with the speaker." : error.message}
      </p>
      <div className="row wrap">
        {!notFound && (
          <button type="button" className="secondary" onClick={retry}>
            Try again
          </button>
        )}
        <Link to="/join" className="button-link">
          Enter another code
        </Link>
      </div>
    </section>
  );
}
