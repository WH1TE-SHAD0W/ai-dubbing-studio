# AI Dubbing Studio

A host speaks once; every listener hears them live in their own language, in the host's voice, with captions. The full documentation is at <https://wh1te-shad0w.github.io/ai-dubbing-studio/>, written in [`docs/`](docs/).

The proof of concept has been removed and the app is being rebuilt to the [target architecture](docs/architecture.md) and its [decision records](docs/adr/index.md).

## Repository layout

A pnpm monorepo (ADR-0016, ADR-0017):

| Folder | What it is | State |
|---|---|---|
| `packages/contracts` | Zod schemas shared by every part: the API contract, form rules, the dubbing-container request | Started |
| `apps/web` | The React PWA for hosts and listeners: Register, Login, Join, Studio and Listener pages | Started, runs against a mock API |
| `apps/api` | Hono API: logins, sessions, LiveKit tokens; serves the PWA | Not started |
| `apps/dubbing-container` | One translation stream per language, publishes audio to LiveKit | Not started |
| `docs/` | The documentation site (MkDocs) | |

## Run it

You need Node.js 24 or later. pnpm comes through Corepack, which ships with Node.

```bash
corepack pnpm install
corepack pnpm dev:mock      # http://localhost:5173, with a mock API in the browser
```

In mock mode you can log in as `host@example.com` / `demo password 123`, or join the demo session with code `DEMO42`. See the [Setup Guide](docs/setup-guide.md) for more.

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```
