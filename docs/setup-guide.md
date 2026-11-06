# Setup Guide

How to run AI Dubbing Studio on your own machine while it is being rebuilt. So
far there are the shared schemas, the app (the React PWA) and the first part of
the Hono API: it serves the app and handles host logins, with accounts in
Postgres. Sessions, LiveKit and the dubbing container are not built yet. The plan
is in the [Architecture](architecture.md) page and the
[decision records](adr/index.md).

## What you need

- [Node.js](https://nodejs.org/) 24.7 or later (the API hashes passwords with
  Argon2 from `node:crypto`).
- pnpm, through Corepack, which comes with Node. Run `corepack enable` once (see
  [Install](#install)); the version is pinned in the root `package.json`.
- [Docker](https://docs.docker.com/get-docker/) with Docker Compose, for
  Postgres and the API container.

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
| `apps/api` | `@ads/api` | The Hono API: serves the app, host logins with Better Auth ([ADR-0007](adr/0007-backend-framework.md), [ADR-0012](adr/0012-serving-pwa-bundle.md), [ADR-0015](adr/0015-auth-library.md)) |

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

## Run with Docker

Postgres and the API, with the built app, in two containers:

```bash
docker compose up --build    # open http://localhost:3000
```

The API waits for Postgres to be healthy, creates its tables on the first start,
then serves the app. You can register a host, log in and log out. Creating a
session or joining one shows "isn't available yet", because sessions and LiveKit
aren't built.

```bash
docker compose ps            # both should show (healthy)
docker compose logs -f api   # requests and start-up messages
```

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
docker compose up -d postgres
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

## Run Postgres

The database runs in Docker Compose (`docker-compose.yml` at the repository
root), with the settings from [`.env`](#settings-env).

```bash
docker compose up -d postgres   # start only Postgres, in the background
docker compose ps               # wait until STATUS shows (healthy)
```

- Postgres listens on `localhost:5432` only, so other machines on the network
  can't reach it. The API in Docker reaches it as `postgres:5432`; the API on
  your machine connects with `DATABASE_URL` from `.env`.
- The API creates Better Auth's tables (`user`, `account`, `logins`,
  `verification`, `rateLimit`) when it starts, and adds any that are missing
  after an update.
- The data is kept in the `postgres-data` volume, so it survives
  `docker compose down` and `docker compose up`.
- `docker compose down -v` also deletes the volume, which wipes the database.
  Use it to start again from empty.
