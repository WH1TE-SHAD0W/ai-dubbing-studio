# AI Dubbing Studio

A host speaks once, and every listener hears them live in their own language, in
the host's voice. Translation is done by the Gemini Live Translate API, with one
translation stream per target language shared by all of that language's
listeners, so cost grows with languages, not listeners.

## Start here

| Page | For |
|---|---|
| [User Guide](user-guide.md) | Hosts and listeners using the app |
| [Setup Guide](setup-guide.md) | Running the app on your own machine |
| [Architecture](architecture.md) | How the parts fit together |
| [API](api.md) | The API's HTTP endpoints, for the app and the translator workers |
| [Deployment](deployment.md) | Running the app on a server, and every setting in `.env` |
| [CI/CD](ci-cd.md) | The automatic checks and how the docs site is published |
| [Testing](testing.md) | Automated tests, checking against the real Gemini API, and debugging |
| [Decisions (ADRs)](adr/index.md) | Why we chose what we chose |
| [Changelog](changelog.md) | What has changed |

## Where the project is

Working today, in Docker Compose:

- **Hosts** register and log in (Better Auth, with accounts in PostgreSQL).
- **Sessions:** a host creates a session, shares its join code, takes it live
  and ends it. Listeners find a session by its code and pick a language.
- **Translation:** going live sends one job per target language through a
  Redis Stream. An idle translator worker (Go) claims it from the API and
  translates with Gemini Live Translate. Ending the session stops the workers,
  and a worker that crashes or is stopped is replaced by another.

Not built yet:

- **Using LiveKit**, which carries the audio: the host's microphone in, and
  each language out to its listeners. Its server already runs in Docker
  Compose, but the app, the API and the workers don't connect to it yet.
  Until they do, a worker reads the host's audio from a WAV file and writes
  the translation to another one.
- **Captions.**

The [decision records](adr/index.md) behind it:

- **Backend:** a Hono API, with the translation in separate single-use
  translator workers written in Go, which take their jobs from a Redis Stream
  ([ADR-0007](adr/0007-backend-framework.md),
  [ADR-0018](adr/0018-autoscaling-architecture-of-translation-container.md),
  [ADR-0019](adr/0019-translation-worker-runtime.md)).
- **Audio:** LiveKit, with a source room for the host and one room per language
  ([ADR-0001](adr/0001-audio-fan-out.md), [ADR-0020](adr/0020-input-audio-stream.md)).
- **App:** one React PWA for hosts and listeners, served by the API
  ([ADR-0010](adr/0010-mobile-native.md), [ADR-0012](adr/0012-serving-pwa-bundle.md)).
- **Storage and logins:** PostgreSQL, with host accounts and logins through
  Better Auth ([ADR-0002](adr/0002-session-and-account-storage.md),
  [ADR-0015](adr/0015-auth-library.md)).

These docs live in the project's repository and are reviewed in pull requests like
the code.
