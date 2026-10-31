# AI Dubbing Studio

A host speaks once, and every listener hears them live in their own language, in
the host's voice, with captions. Translation is done by the Gemini Live Translate
API, with one translation stream per target language shared by all of that
language's listeners, so cost grows with languages, not listeners.

## Start here

| Page | For |
|---|---|
| [User Guide](user-guide.md) | Hosts and listeners using the app |
| [Setup Guide](setup-guide.md) | Running the app on your own machine |
| [Architecture](architecture.md) | How the parts fit together (target design) |
| [API](api.md) | The backend's HTTP and WebSocket API |
| [Deployment](deployment.md) | Running the app on a server |
| [Testing](testing.md) | Automated tests and checking against the real Gemini API |
| [Decisions (ADRs)](adr/index.md) | Why we chose what we chose |
| [Changelog](changelog.md) | What has changed |

## Where the project is

The app works today with sessions kept in memory, one host account set in `.env`
and audio sent to listeners over WebSockets.

The [decision records](adr/index.md) plan the MVP:

- **Backend:** Hono, split into an API container and a separate dubbing
  container that talks to Gemini.
- **Listener audio:** LiveKit, with one audio track per language.
- **App:** one React PWA for hosts and listeners, served by the API container.
- **Storage and logins:** PostgreSQL, with host accounts and logins through
  Better Auth.

These docs live in the project's repository and are reviewed in pull requests like
the code.
