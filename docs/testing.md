# Testing

Every package is tested with [Vitest](https://vitest.dev/). The tests need no
API key and no running server, so they are free and can run on every change.
Only the API's main test needs a database: Postgres from Docker Compose.

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
| `apps/api/test/password.test.ts` | Argon2id hashing (the stored settings, salts, older settings still verifying, malformed hashes) and the common-password list |
| `apps/api/test/env.test.ts` | The settings schema: defaults, comma lists, and an error naming each bad setting |
| `apps/api/test/livekit-rooms.test.ts` | The room names (ADR-0020), and against LiveKit: creating a session's source and output rooms, deleting them in two steps, deleting rooms that are already gone, and a clear error with nothing left behind when LiveKit refuses |
| `apps/api/test/livekit-tokens.test.ts` | Each LiveKit token read back: the room, exactly what it allows (listener listens, host sends, worker hears the source hidden and publishes its output), the 10-minute expiry and the signature; and against LiveKit, that it accepts them and refuses a forged one |
| `apps/api/test/app.test.ts` | The whole API against Postgres: sign-up, login, the 12-hour login row, the failure messages, the login rate limit, logout, the host-only check, the placeholder routes and serving the app |

The app tests run against the same **mock API** as `pnpm dev:mock`
(`apps/web/src/mocks/handlers.ts`), intercepted in Node by
[MSW](https://mswjs.io/). The mock validates each request with the shared
schemas, so a test fails if the app sends something the contract doesn't allow.

### API tests against Postgres

`apps/api/test/app.test.ts` calls the real Hono app with a real Better Auth and
database, without starting a server. It needs `DATABASE_URL` (or
`TEST_DATABASE_URL`, which wins) and is skipped without it:

```bash
docker compose up -d postgres
pnpm --filter @ads/api test      # with DATABASE_URL set, as in .env
```

It uses a new email and a made-up client IP in each test, so it can run against
a database that already has data, and repeatedly.

### Room tests against LiveKit

`apps/api/test/livekit-rooms.test.ts` and the second part of
`apps/api/test/livekit-tokens.test.ts` talk to a real LiveKit. It needs
`LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`, for example the LiveKit
from Docker Compose with the values in `.env`, and skips those tests without
them. Each test uses a new session ID and deletes its rooms, so it never
touches real sessions. The room-name tests always run.

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
