# @ads/web

The React PWA for hosts and listeners, rebuilt to the [target architecture](../../docs/architecture.md). It has the five pages from [ADR-0014](../../docs/adr/0014-pages.md): Register, Login, Join, Studio and Listener. There is no API yet, so it runs against a mock API in the browser.

## Stack

| Part | What |
|---|---|
| UI | React 19, TypeScript |
| Build | Vite, `vite-plugin-pwa` (manifest and app-shell cache only, [ADR-0010](../../docs/adr/0010-mobile-native.md)) |
| Routing | `@tanstack/react-router`, routes in `src/router.tsx` |
| Login | Better Auth client, against `/api/auth` |
| Listener audio | LiveKit (`livekit-client`, `@livekit/components-react`), loaded only when listening starts |
| Validation | Zod schemas from [`@ads/contracts`](../../packages/contracts) |
| Tests | Vitest, Testing Library, jsdom, MSW |

## Run it

You need Node.js 24 or later. pnpm comes through Corepack: run `corepack enable` once (the scripts call plain `pnpm`). From the repository root:

```bash
corepack enable    # once
pnpm install
pnpm dev:mock      # http://localhost:5173, with a mock API in the browser
```

In mock mode:

- Log in as `host@example.com` with the password `demo password 123`, or register a new host.
- Join the live demo session with code `DEMO42`, or `WAIT01` for one that hasn't started.
- Listening gets as far as connecting to LiveKit, then shows a connection error, because there is no LiveKit server behind the mocks.

Against a real API on port 3000 (once it exists), run `pnpm dev`. The dev server forwards `/api` there; set `API_URL` to use another address.

```bash
pnpm typecheck
pnpm test
pnpm build         # output in apps/web/dist
```

The microphone and the service worker need a secure context: `localhost` works, anywhere else needs HTTPS.

## Layout

| Folder | What |
|---|---|
| `src/pages/` | One component per page; `studio/` holds the create form and the control room |
| `src/features/mic/` | Microphone picker and level meter. Nothing is requested until the host taps it; the choice is remembered (`ads.mic`) |
| `src/features/listen/` | LiveKit playback and lock-screen controls (Media Session) |
| `src/lib/` | API client (every response checked with the contract schemas), auth client, service-worker update banner |
| `src/mocks/` | MSW handlers for the mock API, dev and tests only, never in a build |
| `src/app.test.tsx` | Whole-app tests through the real router |

## Not decided yet

How the host's microphone audio reaches the dubbing container, and how captions are delivered. The UI shows a short note in those places.
