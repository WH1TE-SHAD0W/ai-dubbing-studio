# @ads/api

The Hono API from the [target architecture](../../docs/architecture.md). It serves the built PWA and host logins on one origin, with accounts in Postgres, stores sessions, and hands each live session's languages to the translator workers (`apps/translator`). Only the LiveKit listener token is still a placeholder that answers `501`.

## What works

| Part | What it does | Decided in |
|---|---|---|
| Static files | Serves `apps/web/dist`; app routes (`/studio`, `/listen/ABC123`, …) get `index.html`. Hashed files under `/assets` are cached for a year, everything else is revalidated on every load. | [ADR-0012](../../docs/adr/0012-serving-pwa-bundle.md) |
| Postgres | One `pg` pool, shared with Better Auth. Better Auth's tables are created or updated on start. | [ADR-0002](../../docs/adr/0002-session-and-account-storage.md) |
| Host logins | Better Auth at `/api/auth`: sign-up, login, logout, get-session. | [ADR-0003](../../docs/adr/0003-host-authentication.md), [ADR-0015](../../docs/adr/0015-auth-library.md) |
| Validation | Request bodies and parameters are checked with the shared `@ads/contracts` Zod schemas; errors are `{ message }`. | [ADR-0016](../../docs/adr/0016-schema-validator.md) |
| Sessions | `sessions` and `session_languages`: draft → live → ended, one host each, join codes unique among sessions that haven't ended. Going live opens one translation track per language; ending ends them. | [ADR-0002](../../docs/adr/0002-session-and-account-storage.md) |
| Translation tracks | One per session and target language in `translation_tracks`: owner and lease, claimed and renewed by the workers through `/internal` (bearer `INTERNAL_API_TOKEN`). Jobs go to the workers on the Redis Stream `translate:jobs`; a sweeper takes tracks back from crashed workers. | [ADR-0018](../../docs/adr/0018-autoscaling-architecture-of-translation-container.md) |

How ADR-0003 is configured:

- Logins are rows in `logins` (Better Auth's `session` table, renamed), last **12 hours, fixed**, and end on logout. The cookie is `ads.session_token`, `HttpOnly`, `SameSite=Lax`, and `Secure` when `BETTER_AUTH_URL` is https.
- Passwords are hashed with **Argon2id** from `node:crypto` (m=64 MiB, t=3, p=4, 16-byte salt, 32-byte hash), stored as `argon2id$m$t$p$salt$hash`.
- Passwords are 12 to 128 characters, and a short list of very common ones is refused (`src/auth/common-passwords.ts`).
- Every failed login says "Email or password is incorrect.". Better Auth hashes the password for unknown emails too, so the timing matches.
- Rate limits are on in every environment and stored in Postgres: login 5 per minute per IP, sign-up 10 per hour per IP.
- A password change ends the host's other logins.
- The client IP comes from the socket. Better Auth only reads headers, so the API writes `X-Forwarded-For` itself before passing the request on (`src/auth/client-ip.ts`): a client can't choose its own rate-limit bucket. Behind a reverse proxy, list it in `TRUSTED_PROXIES`.

## Placeholders

| Route | Answers |
|---|---|
| `POST /api/join/:code/token` | `400` for a malformed code or unknown language, otherwise `501` (LiveKit isn't connected) |

Not connected yet: LiveKit (ADR-0001, ADR-0013). To see which translator worker has each track of a session, with its lease and attempts:

```bash
pnpm --filter @ads/api tracks list [<session id>]
```

## Run it

You need Node.js 24.7 or later (for Argon2 in `node:crypto`) and Docker. From the repository root:

```bash
cp .env.example .env    # set POSTGRES_PASSWORD, DATABASE_URL, BETTER_AUTH_SECRET and INTERNAL_API_TOKEN
```

**Everything in Docker** (Postgres and Redis, then the API with the built app on <http://localhost:3000>; add `--profile translator` for the workers):

```bash
docker compose up --build
```

**API on your machine**, against Postgres and Redis in Docker:

```bash
docker compose up -d postgres redis
pnpm --filter @ads/web build     # the app the API serves
pnpm --filter @ads/api dev       # http://localhost:3000, restarts on changes
```

Or keep the Vite dev server for the app: run `pnpm dev` alongside the API and open <http://localhost:5173>. It forwards `/api` to port 3000, and `TRUSTED_ORIGINS` must include `http://localhost:5173`.

Node runs the TypeScript files directly (type stripping), so there is no build step in development. The Docker image bundles the API into one file with esbuild (`pnpm --filter @ads/api build`, output in `dist/`), so it needs no `node_modules`.

## Settings

Read at start-up and checked with a Zod schema (`src/env.ts`); a bad value stops the server with a message naming it.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | `postgres://` URL. In Docker Compose it is built from the `POSTGRES_*` values. |
| `BETTER_AUTH_SECRET` | required | At least 32 random characters (`openssl rand -base64 32`). Changing it logs everyone out. |
| `BETTER_AUTH_URL` | required | The address the browser uses, e.g. `http://localhost:3000`. https makes the cookie `Secure`. |
| `TRUSTED_ORIGINS` | none | Other origins allowed to log in, comma-separated, e.g. the Vite dev server. |
| `TRUSTED_PROXIES` | none | Reverse proxies in front of the API, comma-separated IPs or CIDR ranges. |
| `PORT` | `3000` | Port to listen on. |
| `WEB_DIST` | `../web/dist` | Folder with the built PWA. |
| `MIGRATIONS_DIR` | `migrations` | Folder with our numbered `.sql` migrations. |
| `REDIS_URL` | required | `redis://` URL of the job stream. In Docker Compose `redis://redis:6379`. |
| `INTERNAL_API_TOKEN` | required | At least 32 characters (`openssl rand -hex 32`), shared with the translator workers. |
| `JOB_STREAM`, `JOB_GROUP` | `translate:jobs`, `translators` | The stream and the workers' consumer group. |
| `LEASE_TTL_SEC` | `15` | How long a claim lasts without a heartbeat. |
| `HEARTBEAT_SEC` | `5` | How often workers renew it; at most a third of the lease. |
| `TRACK_MAX_ATTEMPTS` | `3` | Workers that may fail or vanish on one track before it is marked failed. |

## Endpoints outside `/api`

| Path | Answers |
|---|---|
| `GET /health` | `200` while the process runs |
| `GET /ready` | `200` when Postgres answers, `503` otherwise. The Compose health check uses it. |
| `POST /internal/tracks/:id/{claim,heartbeat,status,release}` | The translator workers' calls, with `Authorization: Bearer <INTERNAL_API_TOKEN>` (see `docs/api.md`). Keep them off the internet. |

## Tests

```bash
docker compose up -d postgres redis
pnpm --filter @ads/api test      # with DATABASE_URL and REDIS_URL set, e.g. from .env
```

`test/app.test.ts` runs the whole app against Postgres: sign-up, login, the 12-hour login row, the Argon2id hash, the failure messages, the login rate limit, logout, the host-only check, sessions from create to end with their translation jobs, joining by code, and the static files. `test/tracks.test.ts` and `test/internal-routes.test.ts` cover translation tracks and the `/internal` routes. All of them use a database of their own (`<database>_test`, created on first use), so a running API never sends their tracks to real workers. `test/queue.test.ts` runs the job stream against Redis. Without `DATABASE_URL` (or `TEST_DATABASE_URL`) and `REDIS_URL`, those are skipped and only the unit tests run.

## Layout

| File | What |
|---|---|
| `src/server.ts` | Start-up: settings, migrations, Redis, the sweeper, listen, shut down on `SIGTERM` |
| `src/app.ts` | The Hono app: health, Better Auth, `/api` routes, `/internal`, the PWA |
| `src/env.ts` | Settings schema |
| `src/db.ts` | Postgres pool |
| `src/migrate.ts` | Creates or updates Better Auth's tables, and applies `migrations/*.sql` |
| `migrations/` | Numbered SQL migrations (ADR-0002), each applied once |
| `src/queue/jobs.ts` | The Redis job stream (ioredis) |
| `src/sessions/` | Sessions: SQL, and the service that opens and ends their translation tracks |
| `src/tracks/` | Translation tracks: SQL, the service the routes call, the sweeper |
| `src/cli/tracks.ts` | The development `tracks list` command |
| `src/auth/` | Better Auth options, Argon2id, common passwords, client IP, host-only and internal-token middleware |
| `src/routes/` | `/api/sessions`, `/api/join` (the token is a placeholder), `/internal` for the workers |
| `src/static.ts` | The PWA and its cache headers |
| `src/validate.ts` | Zod validation with `{ message }` errors |
| `Dockerfile` | Builds the PWA and the API bundle, runs as the `node` user |
