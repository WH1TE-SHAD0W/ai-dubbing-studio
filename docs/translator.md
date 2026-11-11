# Translator

The translator workers and Redis, as they run in Docker Compose. How they work
inside is in [Architecture layers](architecture-layers.md); how to run them on
your machine is in the [Setup Guide](setup-guide.md#run-the-translator-workers).

## Containers

| Container | Built from | What it does | Port |
|---|---|---|---|
| `redis` | `redis:8-alpine` | The translation job stream ([ADR-0018](adr/0018-autoscaling-architecture-of-translation-container.md)), with its append-only file on the `redis-data` volume | 6379, published on `127.0.0.1` only |
| `translator` (profile `translator`) | `apps/translator/Dockerfile` (Go, distroless) | The translator workers: each translates one language of one session with Gemini, then restarts fresh ([ADR-0019](adr/0019-translation-worker-runtime.md)). `TRANSLATOR_REPLICAS` of them, 2 by default. | none; `/health` and `/ready` on 8080 inside |

- The API starts once Postgres and Redis are healthy.
- The translator workers start only with `--profile translator`. They get only
  the Redis address, the API's address, `INTERNAL_API_TOKEN` and the Gemini
  settings, no database or login secrets. They run as a non-root user on a
  read-only filesystem.
- A worker's health check runs `/translator -healthcheck`, which asks its own
  `/health`.
- A worker exits after each job, and the automatic restart is what starts a
  fresh one.
- A worker that gets `SIGTERM` gives its track back to the API, so another
  worker takes it over within a second.

## Settings

These go in `.env` with the rest (see the
[Setup Guide](setup-guide.md#settings-env)).

| Variable | Default | Read by | What it does |
|---|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | the API on your machine, the API tests | How to reach Redis from your machine. In Docker Compose the API and the workers use `redis://redis:6379` instead. |
| `INTERNAL_API_TOKEN` | **required** | the API and the workers | The token the workers send on every `/internal` call. At least 32 random characters, for example from `openssl rand -hex 32`. Both sides must have the same one, so after changing it restart the API and the workers together. |
| `GEMINI_API_KEY` | none | the workers only | A Google AI Studio key with access to the Live Translate model. It never reaches the API or the browser. Without it a worker stops at start with "GEMINI_API_KEY is required" in its log. |
| `GEMINI_MODEL` | `gemini-3.5-live-translate-preview` | the workers | The Gemini model. |
| `TRANSLATOR_REPLICAS` | `2` | Docker Compose | How many workers run. Each translates one language at a time, so this is how many languages can be live at once; a language waits until a worker is free. |
| `TRANSLATOR_CONTROL_API_URL` | the `api` container (`http://api:3000`) | Docker Compose, for the workers | Where the workers find the API. Set `http://host.docker.internal:3000` when the API runs on your machine instead of in Docker. |
| `TRANSLATOR_LOG_LEVEL` | `info` | Docker Compose, for the workers | `debug` adds a line for each transcript the worker receives, without its text. |

`INTERNAL_API_TOKEN` and `GEMINI_API_KEY` are secrets: keep them only in `.env`.

Docker Compose sets `REDIS_URL=redis://redis:6379` and the workers' media
folder (`/media`, mounted from `apps/translator/media`) itself. The finer
settings (lease length, heartbeat interval, retry limit, buffer sizes and so on)
have defaults that need no change; they are listed in `apps/api/README.md` and
`apps/translator/README.md`.

## The translator image

`apps/translator/Dockerfile` is built from the worker's own folder:

```bash
docker build -t ai-dubbing-studio-translator apps/translator
```

1. **Build**: compiles the Go worker into one static program.
2. **Runtime**: `gcr.io/distroless/static-debian12:nonroot`, with only that
   program: no shell, no package manager, about 41 MB. That is why the health
   check is the program itself (`/translator -healthcheck`).

In Docker Compose the worker's filesystem is read-only, apart from `/tmp` and
the media folder, and it gets 15 seconds after `SIGTERM` to give its track back.

## Run them

```bash
docker compose --profile translator up -d --build
```

Without `--profile translator` the workers don't start, and sessions go live
without anything being translated. To see the API's and the workers' logs:

```bash
docker compose logs -f api translator
```

## Things to know

- **Keep `/internal` off the internet.** A reverse proxy should forward only
  the app and `/api`; the workers reach `/internal` inside Docker, with the
  `INTERNAL_API_TOKEN`.
- **The `redis-data` volume needs no backup.** It holds only the job stream: if
  it is lost, the API sends the jobs again from Postgres.
- **Gemini cost:** each language of a live session is one paid Gemini stream,
  from **Go live** until the session ends, and at most 240 minutes per worker.
- **Audio files:** the workers read the host's audio from
  `apps/translator/media/in` and write the translations to
  `apps/translator/media/out`.
