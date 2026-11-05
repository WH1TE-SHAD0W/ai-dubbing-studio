# Setup Guide

How to run AI Dubbing Studio on your own machine while it is being rebuilt. Only
the shared schemas and the app (the React PWA) exist so far; the Hono API and the
dubbing container are not built yet. The plan is in the
[Architecture](architecture.md) page and the [decision records](adr/index.md).

## What you need

- [Node.js](https://nodejs.org/) 24 or later.
- pnpm, through Corepack, which comes with Node. Run `corepack enable` once (see
  [Install](#install)); the version is pinned in the root `package.json`.

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

## Run the app

There is no API yet, so the app normally runs with a **mock API** in the browser
([MSW](https://mswjs.io/)). It answers the same requests the Hono API will, using
the same schemas.

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

To run against a real API instead (once it exists), start it on port 3000 and
run:

```bash
pnpm dev
```

The dev server forwards `/api` to `http://localhost:3000`; set `API_URL` to use
another address. In production Hono serves the built app itself, on the same
origin ([ADR-0012](adr/0012-serving-pwa-bundle.md)).

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
The microphone, screen wake lock and service worker only work in a **secure
context**. `localhost` counts as one. Anywhere else (a LAN address or a server),
serve the app over HTTPS. nginx passes on `X-Forwarded-Proto`, so the login
cookie becomes `Secure` automatically behind HTTPS.

## Run Postgres

The database runs in Docker Compose (`docker-compose.yml` at the repository
root). Its settings come from a `.env` file, which Git ignores.

```bash
cp .env.example .env    # then change POSTGRES_PASSWORD and DATABASE_URL to match
docker compose up -d    # start Postgres in the background
docker compose ps       # wait until STATUS shows (healthy)
```

- Postgres listens on `localhost:5432` only, so other machines on the network
  can't reach it. The API connects with `DATABASE_URL` from `.env`.
- The data is kept in the `postgres-data` volume, so it survives
  `docker compose down` and `docker compose up`.
- `docker compose down -v` also deletes the volume, which wipes the database.
  Use it to start again from empty.
