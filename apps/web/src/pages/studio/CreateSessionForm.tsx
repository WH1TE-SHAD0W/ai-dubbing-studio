import {
  LANGUAGE_CODES,
  type LanguageCode,
  MAX_TARGET_LANGUAGES,
  type Provider,
  createSessionRequestSchema,
  languageName,
} from "@ads/contracts";
import { type FormEvent, useState } from "react";
import { LanguageSelect } from "../../components/LanguageSelect.tsx";
import { MicPicker } from "../../features/mic/MicPicker.tsx";
import { api } from "../../lib/api.ts";
import { fieldErrors } from "../../lib/form.ts";

export function CreateSessionForm({ onCreated }: { onCreated: (sessionId: string) => void }) {
  const [title, setTitle] = useState("");
  const [sourceLang, setSourceLang] = useState<LanguageCode>("en");
  const [targetLangs, setTargetLangs] = useState<LanguageCode[]>([]);
  const [provider, setProvider] = useState<Provider>("gemini");
  const [speaker, setSpeaker] = useState(false);
  const [aiNotice, setAiNotice] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  function changeSource(lang: LanguageCode) {
    setSourceLang(lang);
    setTargetLangs((t) => t.filter((l) => l !== lang));
  }

  function toggleTarget(lang: LanguageCode) {
    setTargetLangs((t) => (t.includes(lang) ? t.filter((l) => l !== lang) : [...t, lang]));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = createSessionRequestSchema.safeParse({
      title,
      sourceLang,
      targetLangs,
      provider,
      consent: { speaker, aiNotice },
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const session = await api.createSession(parsed.data);
      onCreated(session.id);
    } catch (error) {
      setErrors({ form: error instanceof Error ? error.message : "Couldn't create the session." });
    } finally {
      setBusy(false);
    }
  }

  const full = targetLangs.length >= MAX_TARGET_LANGUAGES;

  return (
    <div className="stack">
      <form className="card stack" onSubmit={onSubmit} noValidate aria-labelledby="create-heading">
        <h2 id="create-heading">Create a session</h2>
        {errors.form && <p className="error" role="alert">{errors.form}</p>}

        <label className="field">
          <span>Session title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} aria-invalid={Boolean(errors.title)} />
          {errors.title && <small className="error">{errors.title}</small>}
        </label>

        <LanguageSelect label="Spoken language" value={sourceLang} onChange={changeSource} />

        <fieldset className="field">
          <legend>
            Target languages <span className="hint">({targetLangs.length}/{MAX_TARGET_LANGUAGES}, each is a separate paid stream)</span>
          </legend>
          <div className="chips">
            {LANGUAGE_CODES.filter((l) => l !== sourceLang).map((lang) => {
              const selected = targetLangs.includes(lang);
              return (
                <button
                  key={lang}
                  type="button"
                  className={`chip ${selected ? "chip-on" : ""}`}
                  aria-pressed={selected}
                  disabled={!selected && full}
                  onClick={() => toggleTarget(lang)}
                >
                  {languageName(lang)}
                </button>
              );
            })}
          </div>
          {errors.targetLangs && <small className="error">{errors.targetLangs}</small>}
        </fieldset>

        <label className="field">
          <span>Translation provider</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
            <option value="gemini">Gemini Live Translate</option>
          </select>
        </label>

        <fieldset className="field">
          <legend>Consent</legend>
          <label className="check">
            <input type="checkbox" checked={speaker} onChange={(e) => setSpeaker(e.target.checked)} />
            The speaker agrees to have their voice replicated in the translated audio.
          </label>
          {errors["consent.speaker"] && <small className="error">{errors["consent.speaker"]}</small>}
          <label className="check">
            <input type="checkbox" checked={aiNotice} onChange={(e) => setAiNotice(e.target.checked)} />
            Listeners will be told the translated audio is AI-generated.
          </label>
          {errors["consent.aiNotice"] && <small className="error">{errors["consent.aiNotice"]}</small>}
        </fieldset>

        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Creating…" : "Create session"}
        </button>
      </form>
      <MicPicker />
    </div>
  );
}
