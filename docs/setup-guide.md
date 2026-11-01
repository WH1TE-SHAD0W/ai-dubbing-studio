# Setup Guide

How to run AI Dubbing Studio on your own machine. This describes the app as it
works today: sessions are kept in memory and there is one host account set in
`.env`. Planned changes are in the [decision records](adr/index.md).

## What you need

- [Docker](https://docs.docker.com/get-docker/) with Docker Compose, to run the app.
- [Node.js](https://nodejs.org/) 22, only for local development without Docker.
- A [Google AI Studio](https://aistudio.google.com/) API key with access to the
  Gemini Live Translate preview model.

## Run with Docker

```bash
cp .env.example .env        # then fill in the settings below
docker compose up --build   # open http://localhost:8080
```

## Settings (`.env`)

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | **Required.** Google AI Studio key. It stays in the backend; the browser never sees it. |
| `GEMINI_MODEL` | Gemini model to use. Default `gemini-3.5-live-translate-preview`. |
| `HOST_EMAIL`, `HOST_PASSWORD` | **Required.** The one host account, checked by the backend. |
| `HOST_NAME` | Optional. The host's display name. |
| `SESSION_SECRET` | Optional. Signs the login cookie. If empty, one is generated at start-up, so a restart logs everyone out. |
| `MAX_SESSION_MINUTES` | A session ends automatically after this long. Default 240. |
| `HOST_GRACE_SECONDS` | A session ends if the host has been disconnected this long. Default 60. |
| `MAX_TARGET_LANGUAGES` | Most target languages per session. Default 5. |
| `LOG_LEVEL` | `info` (default) or `debug`, which adds Gemini message traces and a session report every 5 seconds. |
| `API_UPSTREAM` | Where the frontend's nginx forwards `/api`. Default `http://backend:8000`. |
| `PORT` | Port the app is served on. Default 8080. |

Every target language is a separate paid Gemini stream. `MAX_SESSION_MINUTES`,
`HOST_GRACE_SECONDS` and `MAX_TARGET_LANGUAGES` cap how much one session can spend.

## Local development

Run the backend and frontend in two terminals:

```bash
cd backend && npm install && GEMINI_API_KEY=... HOST_EMAIL=... HOST_PASSWORD=... npm run dev
```

```bash
cd frontend && npm install && npm run dev
```

- The backend runs on port 8000 and the frontend on port 5173, which forwards
  `/api` to the backend.
- In development, `/dev/preview` shows the Studio and Listener screens with
  sample data in each state.

## Secure context

The microphone, screen wake lock and service worker only work in a **secure
context**. `localhost` counts as one. Anywhere else (a LAN address or a server),
serve the app over HTTPS. nginx passes on `X-Forwarded-Proto`, so the login
cookie becomes `Secure` automatically behind HTTPS.
