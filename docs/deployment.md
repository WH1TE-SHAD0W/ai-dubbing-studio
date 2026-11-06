# Deployment

The app runs in Docker Compose. Settings are in `.env`; see the
[Setup Guide](setup-guide.md#settings-env). The plan is to deploy to Kubernetes,
with Docker Compose as the backup; the image below is the same for both.

## Containers

| Container | Built from | What it does | Port |
|---|---|---|---|
| `postgres` | `postgres:18-alpine` | Host accounts and logins ([ADR-0002](adr/0002-session-and-account-storage.md)), on the `postgres-data` volume | 5432, published on `127.0.0.1` only |
| `api` | `apps/api/Dockerfile` (Node 24 Alpine) | The Hono API: serves the built app, host logins with Better Auth ([ADR-0012](adr/0012-serving-pwa-bundle.md), [ADR-0015](adr/0015-auth-library.md)) | 3000 inside, `API_PORT` (default 3000) on `127.0.0.1` |

- The API starts once Postgres is healthy, and creates or updates its tables
  before it accepts requests.
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
- **Both ports are published on `127.0.0.1` only**, so only that machine (and a
  reverse proxy on it) can reach them.
- **Secrets stay in `.env`**, which is git-ignored: the Postgres password and
  `BETTER_AUTH_SECRET`. Changing the secret logs every host out.
- **Back up the `postgres-data` volume**: it holds every host account.
  `docker compose down -v` deletes it.
- **More than one API container works**: logins and rate limits are kept in
  Postgres, not in memory.

> **Planned changes:** a LiveKit container for listener audio, and a separate
> dubbing container that talks to Gemini (ADR-0008, ADR-0009). See the
> [decision records](adr/index.md).
