# API

The backend's HTTP and WebSocket API, as it works today. In the browser every
path is under `/api`; nginx removes that prefix before passing the request on.

**Host only** means the request needs the host's login cookie.

## Login

| Call | Body → response | Notes |
|---|---|---|
| `POST /auth/signin` | `{email, password}` → `{name}` | Sets a signed `HttpOnly` cookie that lasts 12 hours. 5 attempts per minute per IP, then `429`. |
| `POST /auth/signout` | – | Clears the cookie. |

## Sessions (host only)

| Call | Body → response | Notes |
|---|---|---|
| `POST /sessions` | `{title, sourceLang, targetLangs[], consent: {speaker: true, aiNotice: true, textVersion}}` → `{id, joinCode}` | Creates a session in the draft state. |
| `POST /sessions/:id/start` | → `{id, title, joinCode, sourceLang, startedAt}` | Opens one Gemini stream per target language. Safe to call twice. |
| `GET /sessions/:id/stats` | Server-Sent Events, once a second | `{listeners, latencyMs, tracks: [{lang, state, listeners}]}`. `state` is `starting`, `live`, `error` or `degraded`. |
| `POST /sessions/:id/end` | – | Ends the session. Safe to call twice. |
| `POST /sessions/:id/tracks/:lang/retry` | – | Restarts one language's stream. `409` if that stream is healthy. |
| `GET /sessions/:id/debug` | – | Debug snapshot of the session. |

## Public

| Call | Response | Notes |
|---|---|---|
| `GET /join/:code` | `{title, speakerName, sourceLang, languages[]}` | `404` if the session isn't live. 30 requests per minute per IP. |
| `GET /healthz` | – | Health check. |

## Example: sign in and create a session

With the app running in Docker and the sample login from `.env.example`:

```bash
curl -c cookies.txt -X POST http://localhost:8080/api/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"host@example.com","password":"change-me"}'
# {"name":"Host"}

curl -b cookies.txt -X POST http://localhost:8080/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"title":"Demo","sourceLang":"en","targetLangs":["sk"],"consent":{"speaker":true,"aiNotice":true,"textVersion":"2026-10-v1"}}'
# {"id":"<session id>","joinCode":"<join code>"}
```

This only creates a draft session. Gemini isn't called until `POST /sessions/:id/start`.

## WebSockets

### Host: `/ws/host/:id`

Needs the host's login cookie.

- **Browser → server:** binary audio, PCM16 little-endian, mono, 16 kHz.
- **Server → browser:** captions as JSON, `{type: 'caption', original, translated: {lang: text}}`.
- A second host window replaces the first, which is closed with code `4000`.

### Listener: `/ws/listen/:code?lang=sk`

Public.

- **Server → browser:**
    - binary audio, PCM16 little-endian, mono, 24 kHz
    - `{type: 'caption', original, translated}`
    - `{type: 'speaker', speaking}`: whether the host is talking
    - `{type: 'status', trackDown}`: the language's stream is restarting
    - `{type: 'ended'}`
- **Browser → server:** `{type: 'lang', lang}` switches language without starting
  any new Gemini work.

### Close codes

| Code | Meaning |
|---|---|
| `1000` | Session ended |
| `4000` | Replaced by a newer host window |
| `4400` | Unknown language |
| `4401` | Not logged in |
| `4404` | Session not live |
| `4429` | Rate limited |

> **Planned changes:** listener audio is planned to move to LiveKit (ADR-0001),
> logins to host accounts (ADR-0003) and this API to Hono (ADR-0007). A separate
> dubbing container will talk to Gemini, with its own session contract (ADR-0008
> and ADR-0009). See the [decision records](adr/index.md).
