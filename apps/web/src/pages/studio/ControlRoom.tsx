import { type Session, languageName } from "@ads/contracts";
import { useState } from "react";
import { MicPicker } from "../../features/mic/MicPicker.tsx";
import { api } from "../../lib/api.ts";

const STATUS_TEXT: Record<Session["status"], string> = { draft: "Not live yet", live: "Live", ended: "Ended" };

export function ControlRoom({
  session,
  onChange,
  onNew,
}: {
  session: Session;
  onChange: (s: Session) => void;
  onNew: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const joinUrl = `${window.location.origin}/j/${session.joinCode}`;

  async function run(action: (id: string) => Promise<Session>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await action(session.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Couldn't copy. Select the text and copy it by hand.");
    }
  }

  async function share() {
    if (navigator.share) {
      await navigator.share({ title: session.title, url: joinUrl }).catch(() => undefined);
    } else {
      await copy(joinUrl, "link");
    }
  }

  function end() {
    if (window.confirm("End the session? This stops every language and disconnects all listeners.")) {
      void run(api.endSession);
    }
  }

  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="session-heading">
        <div className="row">
          <h2 id="session-heading">{session.title}</h2>
          <span className={`badge badge-${session.status}`}>{STATUS_TEXT[session.status]}</span>
        </div>
        <p className="hint">Spoken language: {languageName(session.sourceLang)}</p>
        {error && <p className="error" role="alert">{error}</p>}

        <div className="join-code" aria-label="Session code">
          {session.joinCode}
        </div>
        <div className="row wrap">
          <button type="button" className="secondary" onClick={() => void copy(session.joinCode, "code")}>
            {copied === "code" ? "Copied" : "Copy code"}
          </button>
          <button type="button" className="secondary" onClick={() => void share()}>
            {copied === "link" ? "Link copied" : "Share link"}
          </button>
        </div>

        {session.status === "draft" && (
          <button type="button" className="primary" disabled={busy} onClick={() => void run(api.startSession)}>
            {busy ? "Starting…" : "Go live"}
          </button>
        )}
        {session.status === "live" && (
          <button type="button" className="danger" disabled={busy} onClick={end}>
            {busy ? "Ending…" : "End session"}
          </button>
        )}
        {session.status === "ended" && (
          <button type="button" className="primary" onClick={onNew}>
            Create a new session
          </button>
        )}
      </section>

      <section className="card" aria-labelledby="tracks-heading">
        <h2 id="tracks-heading">Language tracks</h2>
        <ul className="list">
          {session.languages.map((l) => (
            <li key={l.lang} className="row">
              <span>{languageName(l.lang)}</span>
              <span className="hint">peak {l.peakListeners} listeners</span>
            </li>
          ))}
        </ul>
        <p className="hint">Live track state and listener counts come once the dubbing container reports them.</p>
      </section>

      {session.status !== "ended" && <MicPicker />}

      <section className="card" aria-labelledby="captions-heading">
        <h2 id="captions-heading">Captions preview</h2>
        <p className="hint">How captions reach the app is still to be decided.</p>
      </section>
    </div>
  );
}
