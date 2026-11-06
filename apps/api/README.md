# @ads/api

The Hono API from the [target architecture](../../docs/architecture.md). It serves the built PWA and host logins on one origin, with accounts in Postgres. This first version covers only what the app needs to log in: sessions, joining and LiveKit tokens are placeholders that answer `501`.

## What works

| Part | What it does | Decided in |
|---|---|---|
| Static files | Serves `apps/web/dist`; app routes (`/studio`, `/listen/ABC123`, …) get `index.html`. Hashed files under `/assets` are cached for a year, everything else is revalidated on every load. | [ADR-0012](../../docs/adr/0012-serving-pwa-bundle.md) |
| Postgres | One `pg` pool, shared with Better Auth. Better Auth's tables are created or updated on start. | [ADR-0002](../../docs/adr/0002-session-and-account-storage.md) |
| Host logins | Better Auth at `/api/auth`: sign-up, login, logout, get-session. | [ADR-0003](../../docs/adr/0003-host-authentication.md), [ADR-0015](../../docs/adr/0015-auth-library.md) |
| Validation | Request bodies and parameters are checked with the shared `@ads/contracts` Zod schemas; errors are `{ message }`. | [ADR-0016](../../docs/adr/0016-schema-validator.md) |

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
| `POST /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions/:id/start`, `POST /api/sessions/:id/end` | `401` without a login, `400` for a request the contract rejects, otherwise `501` |
| `GET /api/join/:code` | `400` for a malformed code, otherwise `501` |
| `POST /api/join/:code/token` | `400` for a malformed code or unknown language, otherwise `501` (LiveKit isn't connected) |

Not connected yet: the dubbing container (ADR-0009) and LiveKit (ADR-0001, ADR-0013).

## Run it

You need Node.js 24.7 or later (for Argon2 in `node:crypto`) and Docker. From the repository root:

```bash
cp .env.example .env    # set POSTGRES_PASSWORD, DATABASE_URL and BETTER_AUTH_SECRET
```

**Everything in Docker** (Postgres, then the API with the built app on <http://localhost:3000>):

```bash
docker compose up --build
```

**API on your machine**, against Postgres in Docker:

```bash
docker compose up -d postgres
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

## Endpoints outside `/api`

| Path | Answers |
|---|---|
| `GET /health` | `200` while the process runs |
| `GET /ready` | `200` when Postgres answers, `503` otherwise. The Compose health check uses it. |

## Tests

```bash
docker compose up -d postgres
pnpm --filter @ads/api test      # with DATABASE_URL set, e.g. from .env
```

`test/app.test.ts` runs the whole app against Postgres: sign-up, login, the 12-hour login row, the Argon2id hash, the failure messages, the login rate limit, logout, the host-only check, the placeholders and the static files. Without `DATABASE_URL` (or `TEST_DATABASE_URL`) it is skipped, and only the unit tests run.

## Layout

| File | What |
|---|---|
| `src/server.ts` | Start-up: settings, migrations, listen, shut down on `SIGTERM` |
| `src/app.ts` | The Hono app: health, Better Auth, `/api` routes, the PWA |
| `src/env.ts` | Settings schema |
| `src/db.ts` | Postgres pool |
| `src/migrate.ts` | Creates or updates Better Auth's tables |
| `src/auth/` | Better Auth options, Argon2id, common passwords, client IP, host-only middleware |
| `src/routes/` | `/api/sessions` and `/api/join` (placeholders) |
| `src/static.ts` | The PWA and its cache headers |
| `src/validate.ts` | Zod validation with `{ message }` errors |
| `Dockerfile` | Builds the PWA and the API bundle, runs as the `node` user |
