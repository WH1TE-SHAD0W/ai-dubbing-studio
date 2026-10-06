# AI Dubbing Studio

A host speaks once; every listener hears them live in their own language, in the host's voice, with captions. See the proposal and HLD for the full design.

Two containers, self-hosted with Docker Compose:

```
host browser ──WS: mic, PCM16 16 kHz──► backend ──► Gemini Live Translate session [sk]
                                          │   ──►  Gemini Live Translate session [de]
listener browsers ◄─WS: PCM16 24 kHz + captions── fan-out by language ◄─┘
            all browser traffic goes through the frontend's nginx at /api (HTTP, SSE, WebSocket)
```

- **`frontend/`**: mobile-first React PWA (six screens from the wireframes), served by nginx.
- **`backend/`**: Node/TypeScript middleware that holds the Gemini connections. It takes the host's microphone audio in and streams translated audio and captions out. **One Gemini session per target language, shared by all of that language's listeners**, so engine cost grows with languages × minutes, not listeners. No database: state is in memory.

## Run it

```bash
cp .env.example .env        # set GEMINI_API_KEY, HOST_EMAIL, HOST_PASSWORD
docker compose up --build   # http://localhost:8080
```

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio key with access to the Live Translate preview. Stays in the backend container. **Required.** |
| `GEMINI_MODEL` | default `gemini-3.5-live-translate-preview` |
| `HOST_EMAIL`, `HOST_PASSWORD`, `HOST_NAME` | The one hardcoded host account, checked by the backend (no DB). **Required** (`HOST_NAME` optional). |
| `SESSION_SECRET` | Signs the login cookie. Empty = generated at boot (a restart signs everyone out). |
| `MAX_SESSION_MINUTES` (240), `HOST_GRACE_SECONDS` (60), `MAX_TARGET_LANGUAGES` (5) | Spend guards, see below. |
| `API_UPSTREAM`, `PORT` | Where nginx forwards `/api`, and the published port. |

**Local dev** (two terminals):

```bash
cd backend  && npm install && GEMINI_API_KEY=... HOST_EMAIL=... HOST_PASSWORD=... npm run dev   # :8000
cd frontend && npm install && npm run dev                                                       # :5173, /api proxied to :8000
```

`npm run typecheck` and `npm test` work in both folders. In frontend dev, `/dev/preview` renders the Studio and Listener screens with sample data in each state (excluded from production builds).

> **The microphone, wake lock and service worker need a secure context.** `localhost` works. Anywhere else (a LAN address, a server), serve it over HTTPS. nginx forwards `X-Forwarded-Proto`, so the login cookie turns `Secure` automatically behind TLS.

## How the translation works

Checked against the [Live Translate guide](https://ai.google.dev/gemini-api/docs/live-api/live-translate) and [session management](https://ai.google.dev/gemini-api/docs/live-api/session-management):

- It is a **continuous audio stream**, not turn-based: host audio goes in as PCM16 mono 16 kHz in 100 ms chunks, translated PCM16 mono 24 kHz comes out, with source and target transcripts for the captions.
- `translationConfig.targetLanguageCode` is fixed per session, hence one session per target language. The **source language is auto-detected**; the "Spoken language" select only labels the captions and excludes a target.
- **The voice is replicated automatically from the live speech.** The API accepts no reference sample, so the app has no voice-recording step: only the consent boxes remain. Voice consistency is a documented limitation of the model.
- Sessions are capped (~15 min audio-only, ~10 min per connection) unless compressed. The backend enables sliding-window compression and session resumption, and on `GoAway` opens a replacement stream *before* retiring the old one.
- A failed stream is retried 3 times (a stream that dies right after opening still counts as a failure, so it cannot loop forever), then the track shows `Error` in the studio with a **Retry** link. The other languages are unaffected. Listeners of a down language see a "restarting" banner.
- Irish (`ga`) is not supported by the model and is not offered. The frontend's language list (`frontend/src/lib/languages.ts`) is static; the backend only validates the code format, so a language Gemini rejects shows up as a track `Error`.

**Spend guards** (every target language is a separate paid stream): a session ends automatically if the host has been disconnected for `HOST_GRACE_SECONDS`, or after `MAX_SESSION_MINUTES`; at most `MAX_TARGET_LANGUAGES` per session; shutting the backend down closes every Gemini stream. Audio is relay-only (never written to disk), captions live in memory, and no audio or transcript is logged. Consent is logged as a single line.

## API (all under `/api`; nginx strips the prefix)

| Call | Notes |
|---|---|
| `POST /auth/signin` `{email,password}` → `{name}` | httpOnly signed cookie, 12 h. 5 attempts/min/IP, then 429. `POST /auth/signout` clears it. |
| `POST /sessions` | host only. `{title, sourceLang, targetLangs[], consent:{speaker:true, aiNotice:true, textVersion}}` → `{id, joinCode}` |
| `POST /sessions/:id/start` | host only, **idempotent** → `{id, title, joinCode, sourceLang, startedAt}`. Opens the Gemini streams. |
| `GET /sessions/:id/stats` | host only, Server-Sent Events, 1 Hz: `{listeners, latencyMs, tracks:[{lang, state, listeners}]}`, `state` ∈ `starting\|live\|error\|degraded` |
| `POST /sessions/:id/end` · `POST /sessions/:id/tracks/:lang/retry` | host only; end is idempotent, retry returns 409 if the track is healthy |
| `GET /join/:code` | public. `{title, speakerName, sourceLang, languages[]}`; 404 if not live; 30/min/IP |
| `GET /healthz` | |

**WebSockets**

- `/ws/host/:id` (host cookie): client → server **binary** PCM16 LE mono 16 kHz. Server → client JSON `{type:'caption', original, translated:{lang:text}}`. A second host window replaces the first (close code 4000).
- `/ws/listen/:code?lang=sk` (public): server → client **binary** PCM16 LE mono 24 kHz, plus JSON `{type:'caption', original, translated}`, `{type:'speaker', speaking}`, `{type:'status', trackDown}`, `{type:'ended'}`. Client → server `{type:'lang', lang}` switches language with no new engine work.
- Close codes: `4401` not signed in · `4404` session not live · `4400` unknown language · `4429` rate limited · `1000` ended.

## Debugging "it connects but Gemini doesn't respond"

```bash
docker compose logs -f backend            # LOG_LEVEL=debug in .env adds per-message traces and a report every 5 s
```

Every line carries the `session` id. Logs hold counts, timings and message *shapes* only, never audio, transcript text or the key.

| Log line | What it tells you |
|---|---|
| `gemini connected (server accepted the setup)` | The model name, key and config were accepted. Everything after this is traffic. |
| `host audio: first frame received` | The browser's mic stream reaches the backend. If this never appears, the problem is the mic or the WebSocket, not Gemini. |
| `gemini: first audio chunk sent` | Host audio is flowing to that language's Gemini session. |
| `gemini: first translated audio received` / `first transcript received` | Gemini answered. Time since the first send is in `afterFirstSendMs`. |
| **WARN** `host is connected but no audio frames are arriving` | The mic isn't capturing (blocked, or the browser wants a tap to start audio). |
| **WARN** `host audio is arriving but it is silent` | Wrong input device, muted, or very quiet (`maxRms` vs `speechThreshold`). |
| **WARN** `gemini is not responding to speech` | 8 s of speech sent and no translated audio back. `likelyCause` says whether Gemini sent *nothing* (model/key/language problem) or replied *without audio* (see `messageKinds` for what it sent instead). |
| `gemini stream closed` / `engine failure` | The reason Gemini gave (code + text), with how much was sent and received. |
| `track state changed` | `starting` → `live` → `degraded` / `error`, with the retry count. |
| `session ended` | Final counters for the whole session, as a post-mortem. |

For a live session you can ask the backend directly (host cookie required):

```bash
curl -b "ads_session=<cookie>" http://localhost:8080/api/sessions/<id>/debug
```

It returns the host's frame count and levels, and per language: chunks sent to Gemini, audio/transcripts received, a histogram of the message kinds Gemini sent (`messageKinds`), token usage, and whether a resume handle exists. Remember that the spoken language must differ from the target: with `echoTargetLanguage` off, Gemini stays silent when the input is already in the target language.

## Notes and limits

- **Single backend replica.** Sessions live in memory and don't survive a restart or redeploy.
- **The login is a hardcoded stand-in** (one account from env, no DB, no password reset). It gates host endpoints and Gemini spend; it is not a user system.
- **Latency figure** in the studio is an approximation: the time from the host going quiet to the end of the translated output, smoothed. Calibrate it before quoting numbers. Good ≤ 1.5 s / Fair ≤ 3 s are placeholders (`frontend/src/lib/time.ts`).
- **Playback bounds listener lag**: audio is scheduled with a ~120 ms jitter buffer, plays slightly faster (×1.1/×1.25) if it piles up, and drops only beyond ~6 s behind.
- Not built: QR code for the join link, UI translation into the target languages (UI is English), telemetry, a per-language test sample (the test sound is a chime), dark mode, TLS termination (put your own in front).

## Checking it against the real Gemini API

The automated tests use a fake engine. To exercise the real service you need a key:

```powershell
cd backend
powershell -File scripts/make-test-wav.ps1                  # speech WAV via Windows TTS (16 kHz mono)
$env:GEMINI_API_KEY="..."; npx tsx scripts/probe.ts test-speech.wav sk
```

The probe streams the WAV in real time and reports time to first translated audio, how transcript fragments arrive, whether a resume handle is offered, and writes `probe-out-sk.wav` to listen to. A few seconds of audio costs very little.
