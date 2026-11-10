# Changelog

## Unreleased

- Setup Guide, checked from a fresh clone: says which `.env` values to replace
  before the first start, and that listening connects to LiveKit but stays
  silent until the workers join it (YGP-73).
- The translation worker's image is built on every pull request and pushed to
  Docker Hub after a merge, next to the API's (YGP-52).
- Studio: once the session is live, the host's microphone is sent to the
  translators through LiveKit, and the Microphone card says whether it's
  sending (YGP-105).
- Listener page: Mute and Volume, "Connecting…" instead of "Disconnected" while
  joining, and "This session has ended" when the host ends it (YGP-106).
- The host gets a mic token for a live session: publish only, in the source
  room (YGP-71).
- Listeners get a LiveKit token: a join code and a language of a live session
  return a listen-only token for that language's room, and the address in the
  new `LIVEKIT_PUBLIC_URL` setting (YGP-71).
- With LiveKit configured, going live creates the session's rooms before its
  translation tracks open, and ending deletes them (YGP-69).
- A worker's claim returns its two LiveKit tokens and the LiveKit URL when the
  API has LiveKit configured (YGP-71).
- LiveKit docs: the Architecture page lists LiveKit as built but not yet
  connected, and the Setup Guide says the session routes don't create rooms
  yet (YGP-73).
- Setup Guide: database migration examples use the real file names, and a
  command checks a fresh database has every table. Data model: room names
  aren't stored (YGP-66).
- Home page, Architecture, Architecture layers, User Guide and README
  updated to what works today; a Translator page covers the workers, Redis,
  their settings and the worker image.
- Logging in works from an address in `TRUSTED_ORIGINS` written with a
  trailing slash (it was refused with "Invalid origin").
- The API's database tests run in their own `_test` database, so a running
  API never sends their tracks to real workers.
- Sessions are stored (ADR-0002): a host creates a draft with a join code,
  takes it live and ends it, and only sees their own. Going live opens one
  translation track per target language, which idle translator workers pick
  up; ending it stops them. Listeners can look a session up by its code. Each
  language in a session shows its translation track's status.
- `apps/translator`: the translator worker in Go (ADR-0018 to ADR-0020). Each
  process takes one job from the Redis Stream `translate:jobs`, claims the
  track from the API, streams the host's audio through one Gemini Live
  Translate session (resumed seamlessly when Gemini asks it to reconnect), then
  exits so a fresh process takes its place. Audio is read from and written to
  WAV files until LiveKit is connected. `/health` and `/ready` probes, a probe
  command for the real Gemini API, and a 41 MB distroless image.
- `packages/contracts/openapi/translator-control.yaml`: the API the workers
  call, with Go and TypeScript types generated from it and Zod schemas checked
  against them.
- `apps/api`: translation tracks in Postgres (the first numbered SQL
  migration), the Redis job stream, the workers' `/internal` routes behind a
  shared token, and a sweeper that recovers tracks from crashed workers. A
  `tracks list` command shows which worker has each track.
- Redis and the translator workers (profile `translator`) in Docker Compose;
  `REDIS_URL`, `INTERNAL_API_TOKEN` and the Gemini settings in `.env.example`.
- API, Setup Guide and Testing pages updated for the translator.
- API image built on every pull request and pushed to Docker Hub after a merge
  into `testing` or `main`, tagged with the commit SHA plus `testing` or `prod`;
  a release tag such as `v0.1.0` adds the version tag (YGP-52).
- Database migrations: the API applies the numbered `.sql` files in
  `apps/api/migrations/` on every start, records them in `schema_migrations`,
  and runs them and Better Auth's under one Postgres lock so API copies starting
  together don't clash (YGP-62).
- LiveKit tokens in the API: a listener token (listen only, one output room), a
  host token (microphone only, the source room) and a worker's two tokens
  (hear the source room hidden, publish to its output room), all expiring after
  10 minutes (YGP-71).
- LiveKit rooms in the API: room names from the session and language
  (ADR-0020), creating a session's source room and one output room per
  language, and deleting them in two steps; new `LIVEKIT_` settings, passed to
  the `api` container. Tested against a real LiveKit, also in CI (YGP-69).
- Code checks on every pull request: typecheck, tests with a Postgres
  database, and build (YGP-75).
- Proposed ADR-0021: how we deploy. Argo CD on K3s, syncing from a separate
  deploy repository, with Docker Compose as the fallback if the cluster isn't
  ready by 11 November (YGP-80).
- Deployment page: the Kubernetes manifests live in their own repository,
  `ai-dubbing-studio-deploy` (YGP-81).
- Branch protection written down as a ruleset file
  (`.github/rulesets/protect-main-and-testing.json`): pull request with one
  approval, no deleting or force-pushing `main` and `testing`; the CI/CD page
  explains its two steps (YGP-76).
- Deployment page rewritten for the current plan: Postgres and the API in
  Docker Compose (built), K3s with Argo CD (planned), rolling back, checking a
  deploy and backing up the database (YGP-83).
- CI/CD page: the docs checks, publishing the site, running and fixing the
  checks, what's enforced today, and the planned code CI (YGP-77).
- `apps/api`: the Hono API, first part. It serves the built app with cache
  headers, connects to Postgres and handles host sign-up, login and logout with
  Better Auth, configured as ADR-0003 decides (12-hour logins in a `logins`
  table, Argon2id, rate limits in the database, one message for every failed
  login). Session and listener routes check their requests and answer `501`
  until sessions and LiveKit are built.
- An `api` container in Docker Compose, built by `apps/api/Dockerfile`, with a
  health check; new settings in `.env.example`.
- `packages/contracts`: the API error body (`apiErrorSchema`) and the sign-up and
  rate-limit messages.
- API, Setup Guide, Deployment and Testing pages updated for the API.
- The proof of concept is removed and the app is being rebuilt as a pnpm
  monorepo (ADR-0016, ADR-0017).
- `packages/contracts`: shared Zod schemas for host accounts, sessions, joining,
  listener tokens and the dubbing-container request.
- `apps/web`: the React PWA with the five pages from ADR-0014, a host
  microphone picker, LiveKit listener playback and a minimal service worker. It
  runs against a mock API until the Hono API exists.
- Setup Guide and Testing pages updated for the new layout.
- Docs checks on every pull request: strict site build, Markdown lint, spell check
  and link check (YGP-32).
- Pull request template and a "Writing the docs" page.
- Docs site published to GitHub Pages whenever the docs change on main (YGP-33).
- Decision records for the MVP stack (ADR-0001 to ADR-0003, ADR-0007 to ADR-0017),
  listed in the ADR index.
- `.editorconfig`, so every editor ends files the same way.
- "Changing a decision" in Writing the Docs: accepted ADRs are superseded, not
  rewritten.
- Architecture page rewritten to match the decision records, with listener-join
  and host-login flows.
- "Architecture layers" page with diagrams for the App, API, dubbing container
  and media.
- Proposed ADR-0020: host audio reaches the translation workers through a
  LiveKit source room, with one output room per language (YGP-43).
- Proposed ADR-0019: the translation worker written in Go with no web
  framework; once accepted it supersedes ADR-0017 (YGP-47). It includes measurements
  from a Node vs Go spike with the real SDKs (`benchmarks/runtime-test/`): Go uses about
  half of Node's memory when idle and about a third with a live track.
- Proposed ADR-0018: translation jobs dispatched through a Redis Stream to a
  warm pool of single-use worker pods, one track per pod (YGP-91, YGP-98).
- Postgres in Docker Compose for local development, with a named volume and a
  health check; settings in `.env.example` (YGP-61).
- LiveKit server in Docker Compose (v1.13.11), with its config in
  `config/livekit.yaml`, keys from `.env` and a health check (YGP-68).
