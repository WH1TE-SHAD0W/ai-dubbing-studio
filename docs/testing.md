# Testing

Every package is tested with [Vitest](https://vitest.dev/). The tests need no
API key, no database and no running server, so they are free and can run on
every change.

## Automated tests

From the repository root, for every package:

```bash
pnpm test
```

```bash
pnpm typecheck
```

Or for one package, for example `pnpm --filter @ads/web test`.

| Where | What is tested |
|---|---|
| `packages/contracts/test/` | The shared schemas: join codes, password rules, the create-session rules, the dubbing-container request |
| `apps/web/src/app.test.tsx` | The whole app with its real router: redirects, the Studio login guard, joining by code, the listener's waiting and not-found states, logging in, and creating a session and going live |

The app tests run against the same **mock API** as `pnpm dev:mock`
(`apps/web/src/mocks/handlers.ts`), intercepted in Node by
[MSW](https://mswjs.io/). The mock validates each request with the shared
schemas, so a test fails if the app sends something the contract doesn't allow.

## From the proof of concept

The sections below describe the proof-of-concept backend, which has been
removed. They are kept for when the dubbing container is rebuilt.

### Testing against the real Gemini API

To check the real service, the backend has a probe script. It needs an API key,
and a few seconds of audio costs very little.

```powershell
cd backend
powershell -File scripts/make-test-wav.ps1     # makes a speech WAV with Windows text-to-speech
$env:GEMINI_API_KEY="..."; npx tsx scripts/probe.ts test-speech.wav sk
```

The probe streams the WAV in real time and reports:

- the time until the first translated audio arrives
- how the transcript arrives
- whether Gemini offers a resume handle

It also writes `probe-out-sk.wav` so you can listen to the translation.

### Debugging a live session

When the app connects but Gemini doesn't respond, read the backend logs:

```bash
docker compose logs -f backend
```

Set `LOG_LEVEL=debug` in `.env` for a trace of every Gemini message and a
session report every 5 seconds. Logs hold counts, timings and message types
only, never audio, transcript text or the API key.

| Log line | What it tells you |
|---|---|
| `gemini connected (server accepted the setup)` | The model name, key and settings were accepted. |
| `host audio: first frame received` | The host's microphone audio reaches the backend. If this never appears, the problem is the microphone or the WebSocket, not Gemini. |
| `gemini: first translated audio received` | Gemini answered. |
| WARN `host is connected but no audio frames are arriving` | The microphone isn't capturing (blocked, or the browser needs a tap to start audio). |
| WARN `host audio is arriving but it is silent` | Wrong or muted input. For a mixer or video audio, turn **Voice cleanup** off in the studio's Microphone card. |
| WARN `gemini is not responding to speech` | 8 seconds of speech sent with no translated audio back. `likelyCause` says why. |
| `session ended` | Final counts for the whole session. |

While a session is live, `GET /api/sessions/<id>/debug` (host login needed) gives
a detailed snapshot for each language. The spoken language must differ from the
target language, or Gemini stays silent.
