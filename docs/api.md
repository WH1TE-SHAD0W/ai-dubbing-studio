# API

The Hono API's HTTP endpoints, as they work today. The API serves the app on the
same origin ([ADR-0012](adr/0012-serving-pwa-bundle.md)), so the browser calls
every endpoint under `/api` on the address it opened.

Host logins, sessions, joining by code and the translator workers' internal API
are built. Only the listener token answers `501 Not Implemented`, until LiveKit
is connected.

**Host only** means the request needs the host's login cookie.

## Errors

Every error has the same body, defined by `apiErrorSchema` in
`packages/contracts`:

```json
{ "message": "Email or password is incorrect.", "code": "INVALID_EMAIL_OR_PASSWORD" }
```

`message` is written for the user and the app shows it as it is. `code` is only
there for errors from Better Auth.

| Status | When |
|---|---|
| `400` | The request doesn't match the shared schema. `message` is the first problem, for example "A target language can't be the spoken language." |
| `401` | Not logged in, or the email or password is wrong |
| `404` | Unknown path under `/api`, or a session that doesn't exist or belongs to another host |
| `422` | Sign-up with an email that is already registered |
| `429` | Too many attempts from one IP |
| `501` | Not built yet: the listener token (see below) |

## Host logins

[Better Auth](https://www.better-auth.com/) handles these at `/api/auth`
([ADR-0003](adr/0003-host-authentication.md),
[ADR-0015](adr/0015-auth-library.md)). The app calls them through Better Auth's
client (`apps/web/src/lib/auth.ts`).

| Call | Body → response | Notes |
|---|---|---|
| `POST /api/auth/sign-up/email` | `{name, email, password}` → `{token, user}` | Creates the host and logs them in. Password 12 to 128 characters, not on the common-password list. 10 per hour per IP. |
| `POST /api/auth/sign-in/email` | `{email, password}` → `{token, user}` | Sets the login cookie, valid for 12 hours. 5 per minute per IP. |
| `POST /api/auth/sign-out` | `{}` → `{success}` | Ends the login. |
| `GET /api/auth/get-session` | → `{session, user}`, or `null` | The current login. |

- The login cookie is `ads.session_token`: `HttpOnly`, `SameSite=Lax`, and
  `Secure` when the app runs on https.
- Each login is a row in the `logins` table, so logging out ends it at once.
- Every failed login gets the same message, whether the email exists or not.
- Requests that change something must come from the app's own origin or one
  listed in `TRUSTED_ORIGINS` (Better Auth checks the `Origin` header).

## Sessions (host only)

Stored in Postgres ([ADR-0002](adr/0002-session-and-account-storage.md)). Each
answers the session as `sessionSchema` in `packages/contracts` describes it.

| Call | Body → answer | Notes |
|---|---|---|
| `POST /api/sessions` | `{title, sourceLang, targetLangs[], provider, consent: {speaker: true, aiNotice: true}}` → `201` session | A draft, with a new 6-character join code (no 0/O or 1/I). |
| `GET /api/sessions/:id` | → session | |
| `POST /api/sessions/:id/start` | → session | Draft → live. Opens one translation track per target language, and an idle translator worker takes each one within a second. |
| `POST /api/sessions/:id/end` | → session | Draft or live → ended. Ends its tracks: each worker stops at its next heartbeat, within 5 seconds. |

- Without a login they answer `401`. A session of another host is `404`, the
  same as one that doesn't exist.
- Start and end can be called again: a repeated start changes nothing (or opens
  a track that is missing), a repeated end changes nothing, and an ended session
  never goes live again.
- Each language in the answer has `trackStatus` once the session has started:
  `pending` (waiting for a worker), `claimed`, `live`, `ended` or `failed`.
- Join codes are unique among sessions that haven't ended, so they are reused
  later.

## Listeners (public)

| Call | Body → answer | Notes |
|---|---|---|
| `GET /api/join/:code` | → `{title, hostName, sourceLang, languages[], status}` | For a session that hasn't ended; `404` "No session uses this code." otherwise. The code is not case-sensitive. |
| `POST /api/join/:code/token` | `{lang}` | `501` (LiveKit isn't connected), `400` for a bad code or language |

## Translator workers (internal)

The translator workers call these to take and keep a translation track: one
target language of one session
([ADR-0018](adr/0018-autoscaling-architecture-of-translation-container.md)).
The contract is the OpenAPI document
`packages/contracts/openapi/translator-control.yaml`; the Go worker's client and
these routes are both checked against it.

- **Not for browsers.** Every call needs `Authorization: Bearer
  <INTERNAL_API_TOKEN>`, the token shared with the workers, or it gets `401`.
  Don't route `/internal` through a public reverse proxy or ingress.
- An unknown path under `/internal` is a JSON `404`, never the app.
- A worker finds its work as a message on the Redis Stream `translate:jobs`
  (group `translators`), with `v`, `jobId`, `sessionId`, `trackId` and
  `language`. Redis only delivers: the owner of each track and its lease are
  kept in Postgres (table `translation_tracks`).

| Call | Body → answer | Notes |
|---|---|---|
| `POST /internal/tracks/:trackId/claim` | `{workerId, jobId}` → `{trackId, sessionId, language, leaseTtlSec, heartbeatSec}` | Succeeds for a pending track, an expired lease, or a retried claim by the owner. The lease is 15 seconds. |
| `POST /internal/tracks/:trackId/heartbeat` | `{workerId, state, stats?}` → `{leaseTtlSec}` | Every 5 seconds; renews the lease. `state` is `connecting`, `live` or `reconnecting`. |
| `POST /internal/tracks/:trackId/status` | `{workerId, status, reason?}` → `{ok: true}` | `live` once the Gemini stream is open; `ended` when the worker stops on its own (240-minute limit); `failed` when it gave up. A retried `ended` or `failed` gets `200`. |
| `POST /internal/tracks/:trackId/release` | `{workerId, reason: "sigterm"}` → `{ok: true}` | The worker is shutting down; the track goes straight to another worker. |

A `409` tells the worker to stop, with the reason in `{reason, message}`:

| Reason | On | What the worker does |
|---|---|---|
| `owned` | claim | Another worker has the track: drop the job, wait for the next. |
| `ended` | claim | The track is over: drop the job. |
| `unknown_track` | claim | No such track: drop the job. |
| `ended` | heartbeat, status, release | The session ended: stop and exit. This is how a worker learns that the host ended the session. |
| `not_owner` | heartbeat, status, release | The track went to another worker (this one lost its lease): stop at once and exit, without calling again. |

Behind these, the API keeps tracks moving:

- **A failed track** (`status failed`) goes to another worker, until 3 workers
  have failed or vanished on it (`TRACK_MAX_ATTEMPTS`); then it is `failed`.
- **A released track** goes to another worker at once and doesn't count as an
  attempt.
- **Every 5 seconds** a sweeper takes back tracks whose lease ran out (the worker
  crashed) and sends their jobs again, sends jobs that couldn't be sent while
  Redis was down, and re-sends a job no worker claimed within 30 seconds, once
  every message on the stream has been delivered.

A session's start opens its tracks and its end ends them (see
[Sessions](#sessions-host-only)). To try the whole path, see the
[Setup Guide](setup-guide.md#run-the-translator-workers).

## Health

These are outside `/api`, for Docker and Kubernetes.

| Call | Answers |
|---|---|
| `GET /health` | `200 {status: "ok"}` while the process runs |
| `GET /ready` | `200` when Postgres answers, `503` otherwise |

## Example: register and check the login

With the API running on port 3000. Better Auth needs the `Origin` header on
requests that change something.

```bash
curl -c cookies.txt http://localhost:3000/api/auth/sign-up/email \
  -H "Origin: http://localhost:3000" -H "Content-Type: application/json" \
  -d '{"name":"Ana","email":"ana@example.com","password":"quiet violet harbour"}'

curl -b cookies.txt http://localhost:3000/api/auth/get-session
# {"session":{...,"expiresAt":"<12 hours from now>"},"user":{"name":"Ana",...}}
```
