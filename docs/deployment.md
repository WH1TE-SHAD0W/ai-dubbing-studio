# Deployment

The app is self-hosted with Docker Compose. Settings are in `.env`; see the
[Setup Guide](setup-guide.md#settings-env).

## Containers

| Container | Built from | What it does | Port |
|---|---|---|---|
| `frontend` | `frontend/Dockerfile` (Node 22 build, then nginx) | Serves the React app and forwards `/api` to the backend (HTTP, Server-Sent Events and WebSocket) | `PORT` (default 8080) on the host, 80 inside |
| `backend` | `backend/Dockerfile` (Node 22 Alpine) | Holds the Gemini connections: host audio in, translated audio and captions out | 8000, **not published**: only nginx can reach it |

- Both containers have a health check on `/healthz`. The frontend only starts
  once the backend is healthy.
- Both restart automatically unless stopped by hand.
- The backend runs as the non-root `node` user.

## Deploy or update

On the server, from the repository folder:

```bash
git pull
docker compose up --build -d
```

`-d` runs the containers in the background. To see the backend's logs:

```bash
docker compose logs -f backend
```

## Things to know

- **Run exactly one backend.** Sessions are kept in memory, so a second backend
  wouldn't know about them, and a restart or redeploy ends every live session.
- **HTTPS is not included.** The microphone only works in a secure context, so on
  a server put your own HTTPS reverse proxy (for example Caddy or nginx) in front
  of the `frontend` container.
- **Secrets stay in `.env`**, which is git-ignored. The Gemini API key is only
  given to the backend; the browser never sees it.
- **Every target language is a separate paid Gemini stream.** Keep the spend
  limits in `.env` (`MAX_SESSION_MINUTES`, `HOST_GRACE_SECONDS`,
  `MAX_TARGET_LANGUAGES`) set.

> **Planned changes:** a PostgreSQL container for accounts and sessions, and a
> LiveKit container for listener audio. See the [decision records](adr/index.md).
