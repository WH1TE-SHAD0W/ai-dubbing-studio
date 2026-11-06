# Setup Guide

How to run AI Dubbing Studio on your own machine while it is being rebuilt. So
far there are the shared schemas, the app (the React PWA), the first part of
the Hono API (it serves the app and handles host logins, with accounts in
Postgres), sessions, and the translator workers, which translate each target
language of a live session with Gemini. LiveKit is not connected yet, so the
workers read and write WAV files instead of live audio. The plan is in the
[Architecture](architecture.md) page and the [decision records](adr/index.md).

## What you need

- [Node.js](https://nodejs.org/) 24.7 or later (the API hashes passwords with
  Argon2 from `node:crypto`).
- pnpm, through Corepack, which comes with Node. Run `corepack enable` once (see
  [Install](#install)); the version is pinned in the root `package.json`.
- [Docker](https://docs.docker.com/get-docker/) with Docker Compose, for
  Postgres, Redis, the API container and the translator workers.
- For the translator workers only: a Gemini API key from
  [Google AI Studio](https://aistudio.google.com/) with access to the Live
  Translate model. [Go](https://go.dev/dl/) (the version in
  `apps/translator/go.mod`) only to work on the worker itself; Docker builds it
  otherwise.

## Install

From the repository root, enable Corepack once, then install:

```bash
corepack enable
pnpm install
```

`corepack enable` is required. It puts the pinned `pnpm` on your `PATH`, and the
root scripts (`pnpm -r test` and the like) call plain `pnpm`, so without it
`pnpm test` fails with `'pnpm' is not recognized`. On Windows, run it in an
elevated terminal if it reports a permission error.

The workspace refuses package versions published less than a week ago
(`minimumReleaseAge` in `pnpm-workspace.yaml`), which guards against a freshly
published malicious release.

## Repository layout

| Folder | Package | What it is |
|---|---|---|
| `packages/contracts` | `@ads/contracts` | Zod schemas shared by the app, the API and the dubbing container ([ADR-0016](adr/0016-schema-validator.md)) |
| `apps/web` | `@ads/web` | The React PWA ([ADR-0010](adr/0010-mobile-native.md), [ADR-0014](adr/0014-pages.md)) |
| `apps/api` | `@ads/api` | The Hono API: serves the app, host logins with Better Auth, and hands translation tracks to the workers ([ADR-0007](adr/0007-backend-framework.md), [ADR-0012](adr/0012-serving-pwa-bundle.md), [ADR-0015](adr/0015-auth-library.md), [ADR-0018](adr/0018-autoscaling-architecture-of-translation-container.md)) |
| `apps/translator` | (Go module) | The translator worker: one language of one session per process, through Gemini Live Translate ([ADR-0018](adr/0018-autoscaling-architecture-of-translation-container.md)); design in `apps/translator/pod-spec.md` |
| `packages/contracts/openapi` | | The OpenAPI contract between the API and the workers, from which both sides' types are generated |

## Settings (`.env`)

Docker Compose and the API read their settings from a `.env` file at the
repository root, which Git ignores. Start from the example:

```bash
cp .env.example .env
```

| Variable | Purpose |
|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | The database account Postgres creates on its first start. Change the password; keep it free of `@ : / ? #`, as it goes into a URL. |
| `DATABASE_URL` | How the API connects when it runs outside Docker. Use the same password. |
| `BETTER_AUTH_SECRET` | **Required.** Signs the login cookies: at least 32 random characters, for example from `openssl rand -base64 32`. Changing it logs every host out. |
| `BETTER_AUTH_URL` | The address the browser opens. Default `http://localhost:3000`. With https the login cookie becomes `Secure`. |
| `TRUSTED_ORIGINS` | Other origins allowed to log in, comma-separated. The Vite dev server (`http://localhost:5173`) needs to be listed. |
| `TRUSTED_PROXIES` | Reverse proxies in front of the API (IPs or CIDR ranges), so it can tell the real client IP for rate limits. Empty when browsers connect directly. |
| `API_PORT` | Port Docker Compose publishes the API on. Default 3000. |
| `REDIS_URL` | How the API reaches Redis when it runs outside Docker: `redis://localhost:6379`. Inside Docker Compose it is `redis://redis:6379`. |
| `INTERNAL_API_TOKEN` | **Required.** Shared by the API and the translator workers for their `/internal` calls: at least 32 random characters, for example from `openssl rand -hex 32`. |
| `GEMINI_API_KEY` | For the translator workers. Only the workers read it. |
| `GEMINI_MODEL` | Default `gemini-3.5-live-translate-preview`. |
| `TRANSLATOR_REPLICAS` | How many idle workers to keep. Default 2. |
| `TRANSLATOR_CONTROL_API_URL` | Where the workers find the API. Default the `api` container; set `http://host.docker.internal:3000` when the API runs on your machine. |

## Run with Docker

Postgres, Redis and the API, with the built app:

```bash
docker compose up --build    # open http://localhost:3000
```

The API waits for Postgres and Redis to be healthy, creates its tables on the
first start, then serves the app. You can register a host, log in, create a
session and take it live or end it, and look it up by its code. Listening shows
"isn't available yet", because LiveKit isn't connected.

```bash
docker compose ps            # all should show (healthy)
docker compose logs -f api   # requests and start-up messages
```

## Run the translator workers

The workers translate one target language of one session each
([ADR-0018](adr/0018-autoscaling-architecture-of-translation-container.md)).
They are opt-in, because they need a Gemini key, and start with the
`translator` profile. Until LiveKit is connected, a worker reads the host's
audio from a WAV file and writes the translation to another one.

1. Put a speech recording in `apps/translator/media/in/input.wav` (PCM16, mono,
   16 kHz; a file named after the language, such as `sk.wav`, is used for that
   language instead). On Windows, text-to-speech makes one:

    ```powershell
    powershell -File apps/translator/scripts/make-test-wav.ps1 -Out apps/translator/media/in/input.wav
    ```

2. Start everything, with two idle workers:

    ```bash
    docker compose --profile translator up -d --build
    ```

3. Watch the API and the workers in a second terminal:

    ```bash
    docker compose logs -f api translator
    ```

4. Open the Studio (<http://localhost:3000/studio>), register a host, and
   create a session with one or two target languages. Then press **Go live**.
   The API opens one translation track per language, and the log shows each
   one `claimed` by an idle worker, then `live` once its Gemini stream is open,
   within a second. Translated speech starts about 3 seconds later, written to
   `apps/translator/media/out/` as `<session>-<language>-<worker>.wav`.

5. Press **End session**. Each worker stops at its next heartbeat (within 5
   seconds) and exits, and a fresh one takes its place.

To see which worker has which track, with its lease and attempts:

```bash
pnpm --filter @ads/api tracks list    # or: tracks list <session id>
```

The session id is in the Studio's address (`/studio?session=<id>`).

A worker uses Gemini only while it has a track. A live session's tracks keep
streaming (silence once the WAV ends) until the session ends, or for at most 240
minutes (`MAX_JOB_MINUTES`), so end test sessions when you are done.

```bash
docker compose logs -f translator   # JSON lines, one job per worker process
```

When the API runs on your machine instead (below), set
`TRANSLATOR_CONTROL_API_URL=http://host.docker.internal:3000` in `.env`. Every
API instance that runs, in Docker or on your machine, hands out tracks and
sweeps them. That is safe, because Postgres decides who owns each track.

## Run the app with a mock API

To work on the app without Docker, run it with a **mock API** in the browser
([MSW](https://mswjs.io/)). It answers the same requests the Hono API does, using
the same schemas, including the parts the API doesn't have yet.

```bash
pnpm dev:mock
```

Open <http://localhost:5173>. In mock mode:

- Log in as `host@example.com` with the password `demo password 123`, or
  register a new host.
- Join the live demo session with code `DEMO42`, or `WAIT01` for one that
  hasn't started.
- Listening gets as far as connecting to LiveKit, then shows a connection error,
  because there is no LiveKit server behind the mocks.

The mock data is kept for the browser tab, so a reload keeps you logged in.

## Run the API on your machine

To work on the API, run it with Node against Postgres in Docker. Node runs the
TypeScript files directly, and restarts when they change:

```bash
docker compose up -d postgres redis
pnpm --filter @ads/web build     # the app the API serves
pnpm --filter @ads/api dev       # http://localhost:3000
```

To work on the app against the real API, keep the API running and start the
Vite dev server in a second terminal:

```bash
pnpm dev                         # http://localhost:5173
```

The dev server forwards `/api` to `http://localhost:3000`; set `API_URL` to use
another address. Log in through <http://localhost:5173> only when
`TRUSTED_ORIGINS` lists it. In production Hono serves the built app itself, on
the same origin ([ADR-0012](adr/0012-serving-pwa-bundle.md)).

## Build

```bash
pnpm build
```

The app is built into `apps/web/dist`, with the web app manifest and a service
worker that caches only the app shell. API calls and audio are never cached. The
mock API is never part of a build. To try the build locally:

```bash
pnpm --filter @ads/web preview
```

## Secure context

The microphone and the service worker only work in a **secure context**.
`localhost` counts as one. Anywhere else (a LAN address or a server), serve the
app over HTTPS.

## Run Postgres and Redis

Both run in Docker Compose (`docker-compose.yml` at the repository root), with
the settings from [`.env`](#settings-env).

```bash
docker compose up -d postgres redis   # start only these, in the background
docker compose ps                     # wait until STATUS shows (healthy)
```

- Postgres listens on `localhost:5432` only, so other machines on the network
  can't reach it. The API in Docker reaches it as `postgres:5432`; the API on
  your machine connects with `DATABASE_URL` from `.env`.
- The API creates Better Auth's tables (`user`, `account`, `logins`,
  `verification`, `rateLimit`) when it starts, and adds any that are missing
  after an update. Our own tables come from the numbered files in
  `apps/api/migrations` (`translation_tracks`, `sessions`,
  `session_languages`), each applied once and recorded in `schema_migrations`.
- The data is kept in the `postgres-data` volume, so it survives
  `docker compose down` and `docker compose up`.
- `docker compose down -v` also deletes the volume, which wipes the database.
  Use it to start again from empty.
- Redis listens on `localhost:6379` only, and keeps its data in the
  `redis-data` volume. It holds only the job stream (`translate:jobs`). Who
  translates each track is kept in Postgres, so if Redis loses its data, the
  API sends the jobs again.
