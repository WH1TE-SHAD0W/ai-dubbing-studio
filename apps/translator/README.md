# Translator worker

The Go worker that translates one language of one session (ADR-0018, ADR-0019,
ADR-0020; design in [pod-spec.md](pod-spec.md)). It waits on the Redis Stream
`translate:jobs` for one job and claims the track from the API. It runs one Gemini
Live Translate stream, then exits; a fresh process takes its place.

LiveKit is not wired in yet. Host audio comes from a WAV file and the translation is
written to a WAV file ([media/in](media/in/README.md)). The `media.Source` and
`media.Sink` interfaces are where the LiveKit adapter will plug in.

## Run it

You need Go (the version in `go.mod`) for local runs, or only Docker for Compose.

```bash
# from the repository root: Postgres, Redis, the API and two workers
# (needs GEMINI_API_KEY and INTERNAL_API_TOKEN in .env)
docker compose --profile translator up -d --build

# sessions aren't stored yet: open test tracks, then end them
pnpm --filter @ads/api tracks open sk de
pnpm --filter @ads/api tracks end <session id>
```

Put the host audio in `media/in/input.wav` first; the translation appears in
`media/out/`. The whole walk-through is in the Setup Guide
(`docs/setup-guide.md`, "Run the translator workers").

The workers call the API's internal endpoints at `CONTROL_API_URL`: the `api`
container in Compose, or the API on your machine with
`TRANSLATOR_CONTROL_API_URL=http://host.docker.internal:3000` in `.env`. Each
worker answers two probes on port 8080:

| Endpoint | 200 when |
|---|---|
| `GET /health` | its connections work: Redis while idle; the lease and Gemini stream while busy |
| `GET /ready` | it is idle and waiting on the stream, able to take a job |

## Develop

From `apps/translator`:

```bash
go test -race ./...                                   # unit tests
REDIS_URL=redis://localhost:6379 go test -race -tags integration ./...   # needs Redis
go generate ./...                                     # after changing the OpenAPI document
```

The control API types in `internal/control/api` are generated from
`packages/contracts/openapi/translator-control.yaml`. CI fails if they drift.

### Check the real Gemini API

`cmd/probe` streams a WAV to Gemini and writes the translation. It costs a little.

```powershell
powershell -File scripts/make-test-wav.ps1        # writes test-speech.wav (PCM16 mono 16 kHz)
$env:GEMINI_API_KEY = "..."
go run ./cmd/probe -wav test-speech.wav -lang sk   # writes probe-out-sk.wav
go run ./cmd/probe -wav test-speech.wav -lang sk -duration 13m   # long run: GoAway and resume
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `REDIS_URL` | required | `redis://` or `rediss://` |
| `CONTROL_API_URL` | required | the API's base URL |
| `INTERNAL_API_TOKEN` | required | shared with the API |
| `GEMINI_API_KEY` | required | |
| `GEMINI_MODEL` | `gemini-3.5-live-translate-preview` | |
| `GEMINI_API_VERSION` | `v1beta` | |
| `GEMINI_MAX_RETRIES` | `3` | failures in a row before giving up |
| `JOB_STREAM` / `JOB_GROUP` | `translate:jobs` / `translators` | |
| `MEDIA_DIR` | `/media` | WAV adapter folder |
| `IN_BUFFER_MS` | `200` | input kept while Gemini reconnects (oldest dropped) |
| `OUT_BUFFER_MAX_MS` | `30000` | |
| `SEND_CHUNK_MS` | `100` | multiple of 20 |
| `MAX_JOB_MINUTES` | `240` | spend guard: the worker ends the track |
| `UNHEALTHY_EXIT_SEC` | `60` | an idle worker exits when Redis stays unreachable this long |
| `HTTP_ADDR` | `:8080` | |
| `LOG_LEVEL` | `info` | `debug` adds transcript metadata |
| `LOG_TRANSCRIPTS` | off | `1` logs transcript text at debug level |
| `POD_NAME` / `WORKER_ID` | hostname | the worker id is the name plus a random suffix |
