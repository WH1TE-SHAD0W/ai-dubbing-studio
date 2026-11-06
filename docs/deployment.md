# Deployment

The app runs in Docker Compose (`docker-compose.yml` at the repository root).
Every setting comes from a `.env` file next to it; each one is explained in
[Settings in `.env`](#settings-in-env).

## Containers

| Container | Built from | What it does | Port |
|---|---|---|---|
| `postgres` | `postgres:18-alpine` | Host accounts, logins, sessions and translation tracks ([ADR-0002](adr/0002-session-and-account-storage.md)), on the `postgres-data` volume | 5432, published on `127.0.0.1` only |
| `redis` | `redis:8-alpine` | The translation job stream ([ADR-0018](adr/0018-autoscaling-architecture-of-translation-container.md)), with its append-only file on the `redis-data` volume | 6379, published on `127.0.0.1` only |
| `livekit` | `livekit/livekit-server:v1.13.11` | The LiveKit media server ([ADR-0001](adr/0001-audio-fan-out.md)), with its settings in `config/livekit.yaml`. Nothing connects to it yet. | 7880 (API), 7881 (TCP media), 7882 (UDP media), on `127.0.0.1` unless `LIVEKIT_BIND` says otherwise |
| `api` | `apps/api/Dockerfile` (Node 24 Alpine) | The Hono API: serves the built app, host logins with Better Auth, sessions, and the translator workers' `/internal` calls ([ADR-0012](adr/0012-serving-pwa-bundle.md), [ADR-0015](adr/0015-auth-library.md)) | 3000 inside, `API_PORT` (default 3000) on `127.0.0.1` |
| `translator` (profile `translator`) | `apps/translator/Dockerfile` (Go, distroless) | The translator workers: each translates one language of one session with Gemini, then restarts fresh ([ADR-0019](adr/0019-translation-worker-runtime.md)). `TRANSLATOR_REPLICAS` of them, 2 by default. | none; `/health` and `/ready` on 8080 inside |

- The API starts once Postgres and Redis are healthy, and creates or updates
  its tables before it accepts requests.
- The translator workers start only with `--profile translator`. They get only
  the Redis address, the API's address, `INTERNAL_API_TOKEN` and the Gemini
  settings, no database or login secrets. They run as a non-root user on a
  read-only filesystem.
- Every container has a health check. The API's uses `GET /ready`, which also
  checks that Postgres answers. A worker's runs `/translator -healthcheck`,
  which asks its own `/health`.
- Every container restarts automatically unless stopped by hand. A worker
  exits after each job, and this is what starts a fresh one.
- The API runs as the non-root `node` user, and stops cleanly on `SIGTERM`: it
  finishes open requests and closes Redis and the database connections, within
  8 seconds. A worker that gets `SIGTERM` gives its track back to the API, so
  another worker takes it over within a second.

## Settings in `.env`

Copy `.env.example` to `.env` (Git ignores it) and fill it in. Docker Compose
reads it and passes each container only the settings it needs. The API, when
you run it on your machine with `pnpm --filter @ads/api dev`, reads the same
file.

### Postgres

| Variable | Default | Read by | What it does |
|---|---|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `dubbing`, `change-me`, `dubbing` | the `postgres` container; Compose also builds the API's database address from them | The database account. Postgres creates it on its **first** start only: changing these later doesn't change an existing database (`docker compose down -v` starts again from empty). Change the password; keep it free of `@ : / ? #`, as it goes into a URL. |
| `DATABASE_URL` | `postgres://dubbing:change-me@localhost:5432/dubbing` | the API on your machine, the `tracks` command, the API tests | How to reach Postgres from your machine. Not used in Docker Compose, where the API gets an address built from the three values above. Use the same password. |

### Host logins

| Variable | Default | Read by | What it does |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | **required** | the API | Signs and encrypts the login cookies. At least 32 random characters, for example from `openssl rand -base64 32`. Changing it logs every host out. |
| `BETTER_AUTH_URL` | `http://localhost:3000` | the API | The address the browser opens. An https address makes the login cookie `Secure`. |
| `TRUSTED_ORIGINS` | none | the API | Other addresses allowed to log in, comma-separated: for example the Vite dev server (`http://localhost:5173`), or `http://127.0.0.1:3000` if you open the app by IP. Each is reduced to its origin, so a trailing slash doesn't matter. |
| `TRUSTED_PROXIES` | none | the API | Reverse proxies in front of the API, as IPs or CIDR ranges. Their `X-Forwarded-For` header is believed, so rate limits see each client's real IP. Leave it empty when browsers connect directly. |
| `API_PORT` | `3000` | Docker Compose | The port the app and the API are published on, on `127.0.0.1`. |

### Translation

| Variable | Default | Read by | What it does |
|---|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | the API on your machine, the API tests | How to reach Redis from your machine. In Docker Compose the API and the workers use `redis://redis:6379` instead. |
| `INTERNAL_API_TOKEN` | **required** | the API and the workers | The token the workers send on every `/internal` call. At least 32 random characters, for example from `openssl rand -hex 32`. Both sides must have the same one, so after changing it restart the API and the workers together. |
| `GEMINI_API_KEY` | none | the workers only | A Google AI Studio key with access to the Live Translate model. It never reaches the API or the browser. Without it a worker stops at start with "GEMINI_API_KEY is required" in its log. |
| `GEMINI_MODEL` | `gemini-3.5-live-translate-preview` | the workers | The Gemini model. |
| `TRANSLATOR_REPLICAS` | `2` | Docker Compose | How many workers run. Each translates one language at a time, so this is how many languages can be live at once; a language waits until a worker is free. |
| `TRANSLATOR_CONTROL_API_URL` | the `api` container (`http://api:3000`) | Docker Compose, for the workers | Where the workers find the API. Set `http://host.docker.internal:3000` when the API runs on your machine instead of in Docker. |
| `TRANSLATOR_LOG_LEVEL` | `info` | Docker Compose, for the workers | `debug` adds a line for each transcript the worker receives, without its text. |

### LiveKit

| Variable | Default | Read by | What it does |
|---|---|---|---|
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | `change-me`, `change-me-to-at-least-32-random-characters` | the `livekit` container | The server's API key and secret, passed in as `LIVEKIT_KEYS`. Set your own; the secret needs at least 32 random characters, for example from `openssl rand -base64 32`. If they are missing, the container keeps restarting. Never use LiveKit's `--dev` keys outside your own machine. |
| `LIVEKIT_URL` | `ws://localhost:7880` | nothing yet | Where LiveKit's API is reached. |
| `LIVEKIT_BIND` | `127.0.0.1` | Docker Compose | The address LiveKit's three ports are published on. `0.0.0.0` makes it reachable from other devices, for example a phone on the same Wi-Fi. |
| `LIVEKIT_NODE_IP` | `127.0.0.1` | the `livekit` container | The address LiveKit tells browsers to send audio to. With `LIVEKIT_BIND=0.0.0.0`, set it to this machine's address on the network. |

**Secrets:** the Postgres password, `BETTER_AUTH_SECRET`, `INTERNAL_API_TOKEN`,
`GEMINI_API_KEY` and `LIVEKIT_API_SECRET`. Keep them only in `.env`.

Docker Compose also sets a few values itself inside the containers, which are
not in `.env`: the API's database address, `REDIS_URL=redis://redis:6379`, and
the workers' media folder (`/media`, mounted from `apps/translator/media`). The
API's and the workers' finer settings (lease length, heartbeat interval, retry
limit, buffer sizes and so on) have defaults that need no change; they are
listed in `apps/api/README.md` and `apps/translator/README.md`.

## The API image

`apps/api/Dockerfile` is built from the repository root, as it needs the whole
pnpm workspace:

```bash
docker build -f apps/api/Dockerfile -t ai-dubbing-studio-api .
```

It builds in two stages:

1. **Build**: installs the workspace with pnpm, builds the app (`apps/web/dist`)
   and bundles the API into one file with esbuild.
2. **Runtime**: Node 24 Alpine with just that file, the SQL migrations and the
   built app. No `node_modules`, pnpm or build tools, about 250 MB in all, most
   of it Node.

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

## Deploy or update

On the server, from the repository folder:

```bash
git pull
docker compose --profile translator up -d --build
```

`-d` runs the containers in the background. Without `--profile translator` the
workers don't start, and sessions go live without anything being translated.
To see the API's and the workers' logs:

```bash
docker compose logs -f api translator
```

## Things to know

- **HTTPS is not included.** The microphone only works in a secure context, so on
  a server put your own HTTPS reverse proxy (for example Caddy or nginx) in front
  of the `api` container. Then set `BETTER_AUTH_URL` to the https address, so the
  login cookie is `Secure`, and list the proxy's address in `TRUSTED_PROXIES`, so
  rate limits see each client's real IP.
- **Every port is published on `127.0.0.1` only**, so only that machine (and a
  reverse proxy on it) can reach them. LiveKit's ports are the one exception
  you can open, with `LIVEKIT_BIND`.
- **Keep `/internal` off the internet.** The reverse proxy should forward only
  the app and `/api`; the workers reach `/internal` inside Docker, with the
  `INTERNAL_API_TOKEN`.
- **Back up the `postgres-data` volume**: it holds every host account and
  session. `docker compose down -v` deletes it. The `redis-data` volume holds
  only the job stream: if it is lost, the API sends the jobs again from
  Postgres, so it needs no backup.
- **More than one API container works**: logins, rate limits and who owns each
  translation track are kept in Postgres, not in memory.
- **Gemini cost:** each language of a live session is one paid Gemini stream,
  from **Go live** until the session ends, and at most 240 minutes per worker.
- **Nothing uses LiveKit yet.** The `livekit` container runs, but the app,
  the API and the workers don't connect to it, so the workers read the host's
  audio from `apps/translator/media/in` and write the translations to
  `apps/translator/media/out`.
