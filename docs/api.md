# API

The Hono API's HTTP endpoints, as they work today. The API serves the app on the
same origin ([ADR-0012](adr/0012-serving-pwa-bundle.md)), so the browser calls
every endpoint under `/api` on the address it opened.

So far only host logins are built. The session and listener endpoints exist with
the paths and request checks the app uses, but answer `501 Not Implemented`
until sessions are stored and LiveKit is connected.

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
| `404` | Unknown path under `/api` |
| `422` | Sign-up with an email that is already registered |
| `429` | Too many attempts from one IP |
| `501` | Not built yet (see below) |

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

## Sessions (host only, not built yet)

| Call | Body | Answers today |
|---|---|---|
| `POST /api/sessions` | `{title, sourceLang, targetLangs[], provider, consent: {speaker: true, aiNotice: true}}` | `501` once the body passes the schema |
| `GET /api/sessions/:id` | – | `501` |
| `POST /api/sessions/:id/start` | – | `501` |
| `POST /api/sessions/:id/end` | – | `501` |

Without a login they answer `401` first.

## Listeners (public, not built yet)

| Call | Body | Answers today |
|---|---|---|
| `GET /api/join/:code` | – | `501` for a valid 6-character code, `400` otherwise |
| `POST /api/join/:code/token` | `{lang}` | `501` (LiveKit isn't connected), `400` for a bad code or language |

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
