# Deployment

The app runs in Docker Compose. Settings are in `.env`; see the
[Setup Guide](setup-guide.md#settings-env). The plan is to deploy to Kubernetes,
with Docker Compose as the backup; the image below is the same for both.

## Containers

| Container | Built from | What it does | Port |
|---|---|---|---|
| `postgres` | `postgres:18-alpine` | Host accounts, logins, sessions and translation tracks ([ADR-0002](adr/0002-session-and-account-storage.md)), on the `postgres-data` volume | 5432, published on `127.0.0.1` only |
| `redis` | `redis:8-alpine` | The translation job stream ([ADR-0018](adr/0018-autoscaling-architecture-of-translation-container.md)), with its append-only file on the `redis-data` volume | 6379, published on `127.0.0.1` only |
| `api` | `apps/api/Dockerfile` (Node 24 Alpine) | The Hono API: serves the built app, host logins with Better Auth, and the translator workers' `/internal` calls ([ADR-0012](adr/0012-serving-pwa-bundle.md), [ADR-0015](adr/0015-auth-library.md)) | 3000 inside, `API_PORT` (default 3000) on `127.0.0.1` |
| `translator` (profile `translator`) | `apps/translator/Dockerfile` (Go, distroless) | Two translator workers, each translating one language of one session with Gemini, then restarting fresh | none; `/health` and `/ready` on 8080 inside |

- The API starts once Postgres and Redis are healthy, and creates or updates
  its tables before it accepts requests.
- The translator workers start only with `--profile translator`. They get only
  `REDIS_URL`, `INTERNAL_API_TOKEN` and the Gemini settings, no database or
  login secrets, and run as a non-root user on a read-only filesystem.
- Both have a health check. The API's uses `GET /ready`, which also checks that
  Postgres answers; `GET /health` only checks that the process runs.
- Both restart automatically unless stopped by hand.
- The API runs as the non-root `node` user, and stops cleanly on `SIGTERM`: it
  finishes open requests and closes the database connections, within 8 seconds.

## The API image

`apps/api/Dockerfile` is built from the repository root, as it needs the whole
pnpm workspace:

```bash
docker build -f apps/api/Dockerfile -t ai-dubbing-studio-api .
```

It builds in two stages:

1. **Build**: installs the workspace with pnpm, builds the app (`apps/web/dist`)
   and bundles the API into one file with esbuild.
2. **Runtime**: Node 24 Alpine with just that file and the built app. No
   `node_modules`, pnpm or build tools, about 250 MB in all, most of it Node.

## Deploy or update

On the server, from the repository folder:

```bash
git pull
docker compose up --build -d
```

`-d` runs the containers in the background. To see the API's logs:

```bash
docker compose logs -f api
```

## Things to know

- **HTTPS is not included.** The microphone only works in a secure context, so on
  a server put your own HTTPS reverse proxy (for example Caddy or nginx) in front
  of the `api` container. Then set `BETTER_AUTH_URL` to the https address, so the
  login cookie is `Secure`, and list the proxy's address in `TRUSTED_PROXIES`, so
  rate limits see each client's real IP.
- **Every port is published on `127.0.0.1` only**, so only that machine (and a
  reverse proxy on it) can reach them.
- **Keep `/internal` off the internet.** The reverse proxy should forward only
  the app and `/api`; the workers reach `/internal` inside Docker. It also needs
  the `INTERNAL_API_TOKEN`.
- **Secrets stay in `.env`**, which is git-ignored: the Postgres password,
  `BETTER_AUTH_SECRET`, `INTERNAL_API_TOKEN` and `GEMINI_API_KEY`. Changing
  `BETTER_AUTH_SECRET` logs every host out.
- **Back up the `postgres-data` volume**: it holds every host account and
  session. `docker compose down -v` deletes it.
- **More than one API container works**: logins, rate limits and who owns each
  translation track are kept in Postgres, not in memory.

> **Planned changes:** a LiveKit container for the host's and the listeners'
> audio, which the translator workers will join instead of reading and writing
> WAV files, and Kubernetes with the workers scaled on demand. See the
> [decision records](adr/index.md).
