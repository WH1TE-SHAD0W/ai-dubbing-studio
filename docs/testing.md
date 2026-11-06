# Testing

Every package is tested with [Vitest](https://vitest.dev/), and the translator
worker with Go's own tests. The tests need no API key and no running server, so
they are free and can run on every change. The API's database tests need
Postgres from Docker Compose, and the job stream tests need Redis.

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
| `packages/contracts/test/` | The shared schemas: join codes, password rules, the create-session rules, the dubbing-container request. `translator.test.ts` checks at type level that each translator schema equals the type generated from the OpenAPI document |
| `apps/web/src/app.test.tsx` | The whole app with its real router: redirects, the Studio login guard, joining by code, the listener's waiting and not-found states, logging in, and creating a session and going live |
| `apps/api/test/password.test.ts` | Argon2id hashing (the stored settings, salts, older settings still verifying, malformed hashes) and the common-password list |
| `apps/api/test/env.test.ts` | The settings schema: defaults, comma lists, the translator settings, and an error naming each bad setting |
| `apps/api/test/app.test.ts` | The whole API against Postgres: sign-up, login, the 12-hour login row, the failure messages, the login rate limit, logout, the host-only check, the placeholder routes, serving the app, and `/internal` never answering with the app |
| `apps/api/test/tracks.test.ts` | Translation tracks against Postgres: a claim race between eight workers, retried claims and reports, every conflict reason, failure retries up to the limit, release on SIGTERM, lease expiry, and when the sweeper re-sends a job |
| `apps/api/test/internal-routes.test.ts` | The workers' `/internal` routes over HTTP: the token, request checks, and the answers checked against the contract |
| `apps/api/test/queue.test.ts` | The job stream against Redis, read the way the Go worker reads it: the message fields, the backlog, removing stopped workers' consumers, failing fast while Redis is down |
| `apps/translator/` (Go) | The worker: audio buffers, settings, the API client, the stream manager on a fake clock (GoAway resume, backoff, retries), the Gemini wire format against a local WebSocket server, every way a job ends, and the probes |

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

The track tests (`tracks.test.ts`, `internal-routes.test.ts`) use a database of
their own: `TEST_DATABASE_URL`, or the `DATABASE_URL` database with `_test`
added (`dubbing_test`), created on first use. Left in the development
database, their pending tracks would be sent to real workers by a running API.
They delete their tracks at the end. `queue.test.ts` needs `REDIS_URL` (or
`TEST_REDIS_URL`) and uses a stream of its own:

```bash
docker compose up -d postgres redis
pnpm --filter @ads/api test      # with DATABASE_URL and REDIS_URL set, as in .env
```

The test files run one at a time, as they share the database.

### Translator worker

From `apps/translator`, with Go installed:

```bash
go test -race ./...                                                       # unit tests
REDIS_URL=redis://localhost:6379 go test -race -tags integration ./...    # also against Redis
```

The integration tests run the whole worker against a real Redis, with a fake
API and a fake Gemini: one job from the stream to exit, a rejected claim that
keeps waiting, and SIGTERM giving the track back.

### Contract drift

The OpenAPI document `packages/contracts/openapi/translator-control.yaml` is the
one source for both sides. After changing it, regenerate both and commit the
result:

```bash
pnpm --filter @ads/contracts gen:openapi    # TypeScript types
cd apps/translator && go generate ./...     # Go types
```

CI regenerates both and fails if anything changed, and `pnpm typecheck` fails
when a Zod schema no longer matches its generated type.

### Against the real Gemini API

`apps/translator/cmd/probe` streams a WAV file to Gemini Live Translate in real
time and writes the translation. It needs an API key; a few seconds of audio
cost very little.

```powershell
cd apps/translator
powershell -File scripts/make-test-wav.ps1          # test-speech.wav, PCM16 mono 16 kHz
$env:GEMINI_API_KEY = "..."
go run ./cmd/probe -wav test-speech.wav -lang sk     # writes probe-out-sk.wav
go run ./cmd/probe -wav test-speech.wav -lang sk -duration 13m   # GoAway and resume
```

It reports the time until the first translated audio (about 3 seconds), the
transcripts, how often Gemini sends a resume handle, and, on a long run, when
Gemini sends GoAway (about every 9 minutes) and how long the new connection
took.

### End to end

The whole path, with the API, Redis, two workers and real Gemini, is in the
[Setup Guide](setup-guide.md#run-the-translator-workers): open a track with
`pnpm --filter @ads/api tracks open sk`, listen to the WAV in
`apps/translator/media/out`, then end it. To see a takeover, `docker stop` the
busy worker (it gives the track back and the other worker has it live within a
second) or `docker kill` it (the lease runs out and another worker takes over
within about 20 seconds).

## From the proof of concept

The section below describes the proof-of-concept backend, which has been
removed. It is kept for when live sessions are rebuilt.

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
