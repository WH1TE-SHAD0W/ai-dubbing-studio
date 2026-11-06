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
| `apps/api/test/app.test.ts` | The whole API against Postgres: sign-up, login, the 12-hour login row, the failure messages, the login rate limit, logout, sessions (created as drafts, only their host sees them, going live sends one translation job per language, ending ends the tracks, both safe to repeat), joining by code, serving the app, and `/internal` never answering with the app |
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
`TEST_DATABASE_URL`, which wins) and is skipped without it. Redis is replaced by
an in-memory job sender:

```bash
docker compose up -d postgres
pnpm --filter @ads/api test      # with DATABASE_URL set, as in .env
```

It uses a new email and a made-up client IP in each test, so it can run against
a database that already has data, and repeatedly.

All the database tests use a database of their own: `TEST_DATABASE_URL`, or the
`DATABASE_URL` database with `_test` added (`dubbing_test`), created on first
use. Left in the development database, their pending translation tracks would be
sent to real workers by a running API. They delete the sessions they made at
the end, and the tracks with them. `queue.test.ts` needs `REDIS_URL` (or
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
[Setup Guide](setup-guide.md#run-the-translator-workers): create a session in
the Studio, press **Go live**, watch the logs, listen to the WAVs in
`apps/translator/media/out`, then press **End session**. To see a takeover, go
live with one language (so the other worker is idle), then `docker stop` the
busy worker (it gives the track back and the other worker has it live within a
second) or `docker kill` it (the lease runs out and another worker takes over
within about 20 seconds). `pnpm --filter @ads/api tracks list` shows which
worker has each track.

## Debugging the translator

When a session goes live but nothing is translated, follow one language through
the logs:

```bash
docker compose logs -f api translator
```

The API's lines, in the order they should appear:

| Log line | What it tells you |
|---|---|
| `sessions: <id> is live; opening 2 translation track(s): sk, de` | **Go live** reached the API and the jobs were sent. |
| `tracks: can't send the job for track <id> yet` | Redis was unreachable. The job stays in Postgres and is sent when Redis is back. |
| `tracks: <worker> claimed <track> (sk, …)` | A worker took the language. If this never comes, no worker is idle: check `docker compose ps` and `TRANSLATOR_REPLICAS`. |
| `tracks: <track> is live (<worker>)` | That worker's Gemini stream is open. |
| `tracks: <worker> released <track> (sigterm)` | The worker was stopped and gave the track back; another one takes it. |
| `tracks: lease on <track> ran out` | The worker stopped sending heartbeats (it crashed); the track goes to another worker. |
| `tracks: <worker> failed on <track>: …` | The worker gave up, with its reason; another worker tries, up to 3 times. |
| `sessions: <id> ended (host_ended)` | **End session**; the workers stop at their next heartbeat. |

A worker's lines (JSON, each with `workerId`, `trackId` and `language`):

| `msg` | What it tells you |
|---|---|
| `worker starting`, then nothing | Idle and waiting for a job. That's normal. |
| `track claimed` | It got a job and the API gave it the track. |
| `claim rejected, job dropped` | Another worker already had the track, or it had ended. Normal after a takeover. |
| `gemini: stream open`, `track live` | The Gemini stream is open. If `stream open` never comes, check `GEMINI_API_KEY` and `GEMINI_MODEL`. |
| `gemini: first translated audio` | Gemini answered, normally about 3 seconds after the first words. If it never comes, check the input WAV in `apps/translator/media/in`, and that it isn't already in the target language. |
| `gemini: goAway`, `gemini: replacing stream`, `gemini: stream replaced` | Gemini asked for a new connection, about every 9 minutes; the worker moved to it without a gap. |
| WARN `gemini: stream closed` | The stream failed; the worker reconnects after 0.5, 1.5 and 4 seconds, and gives up after 3 failures in a row. |
| `session ended (heartbeat 409)`, `job finished` | The session ended, and the worker exited. A fresh one starts. |
| WARN `fenced: another worker owns the track` | This worker lost the track (it was cut off too long); it stops without another call. |
| WARN `reading the stream failed`, `redis not ready` | Redis is unreachable. An idle worker exits after 60 seconds of it, so Docker Compose restarts it. |

To see which worker has each track right now, with its lease and attempts:

```bash
pnpm --filter @ads/api tracks list
```

To look at the job stream itself: `pending` should be 0, because a worker
acknowledges each job as soon as it claims it, and `lag` counts the jobs still
waiting for a free worker.

```bash
docker compose exec redis redis-cli XINFO GROUPS translate:jobs
```

Logs hold ids, counts and timings only, never audio or the API keys. With
`TRANSLATOR_LOG_LEVEL=debug` a worker adds a line for each transcript it
receives: its length and the language Gemini detected, not its text. A
detected language equal to the target means the input is already in that
language, and Gemini stays silent.
