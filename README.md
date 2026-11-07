# AI Dubbing Studio

A host speaks once; every listener hears them live in their own language, in the host's voice. Each target language is one Gemini Live Translate stream, shared by all of that language's listeners, so cost grows with languages, not listeners. The full documentation is at <https://wh1te-shad0w.github.io/ai-dubbing-studio/>, written in [`docs/`](docs/).

## What works today

- Hosts register, log in, create sessions, take them live and end them; listeners find a session by its code.
- Going live sends one job per language through a Redis Stream; an idle translator worker (Go) claims it and translates with Gemini Live Translate. Ending the session stops the workers, and a crashed or stopped worker is replaced.
- A worker reads the host's audio from a WAV file and writes the translation to another one.

## Layout

A pnpm monorepo, plus one Go module:

| Folder | What it is |
|---|---|
| [`apps/web`](apps/web/) | The React PWA for hosts and listeners |
| [`apps/api`](apps/api/) | The Hono API: logins, sessions, the translator workers' internal API, and it serves the app |
| [`apps/translator`](apps/translator/) | The translator worker in Go: one language of one session per process |
| [`packages/contracts`](packages/contracts/) | Shared Zod schemas, and the OpenAPI contract between the API and the workers |
| [`docs`](docs/) | The documentation site |

## Run it

You need Docker with Docker Compose, and a Gemini API key with access to the Live Translate model.

```bash
cp .env.example .env    # set POSTGRES_PASSWORD, BETTER_AUTH_SECRET, INTERNAL_API_TOKEN and GEMINI_API_KEY
docker compose --profile translator up -d --build
```

Put a speech recording in `apps/translator/media/in/input.wav` (PCM16, mono, 16 kHz), then open <http://localhost:3000/studio>, register, create a session and select **Go live**. The translation is written to `apps/translator/media/out/`. The translator's settings are explained on the [Translator](https://wh1te-shad0w.github.io/ai-dubbing-studio/translator/) page, and working on the code without Docker in the [Setup Guide](https://wh1te-shad0w.github.io/ai-dubbing-studio/setup-guide/).

## More

- [Architecture](https://wh1te-shad0w.github.io/ai-dubbing-studio/architecture/): how the parts fit together.
- [API](https://wh1te-shad0w.github.io/ai-dubbing-studio/api/): the HTTP endpoints.
- [Testing](https://wh1te-shad0w.github.io/ai-dubbing-studio/testing/): the tests, the Gemini probe, and debugging.
- [Decisions](https://wh1te-shad0w.github.io/ai-dubbing-studio/adr/): why we chose what we chose.
