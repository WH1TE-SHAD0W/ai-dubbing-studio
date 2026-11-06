# Changelog

## Unreleased

- Docs brought up to date with what works: Home page, Architecture and
  Layers (with the session and worker flows), User Guide, README, Deployment
  (every `.env` setting), Testing (debugging the translator) and CI/CD (the
  Translator workflow).
- ADR-0018, ADR-0019 and ADR-0020 accepted; ADR-0017 superseded by ADR-0019.
- Listeners can look a session up by its join code.
- The API's session answer gives each language's translation status
  (`trackStatus`).
- Ending a session stops its translator workers within 5 seconds.
- Going live sends one translation job per target language; idle workers pick
  them up within a second.
- Sessions are stored: a host creates one with a join code, takes it live and
  ends it, and only sees their own.
- Logging in works from an address listed in `TRUSTED_ORIGINS` with a trailing
  slash (it was refused with "Invalid origin").
- The API's database tests run in their own `_test` database, so a running API
  never sends their tracks to real workers.
- A `tracks list` command shows which worker has each track.
- A worker that is stopped gives its track back and another one takes it
  within a second; a crashed worker's track is taken over once its lease runs
  out.
- The API takes tracks back from crashed workers and re-sends jobs that Redis
  lost or couldn't take (the sweeper, every 5 seconds).
- The API hands out translation tracks to the workers: claim, heartbeat,
  status and release on `/internal`, behind a shared token.
- The API's first SQL migrations: `translation_tracks`, then `sessions` and
  `session_languages`.
- Translator workers connect to Gemini Live Translate, and move to a new
  connection without a gap when Gemini asks (about every 9 minutes).
- Translator workers take one job each from the Redis Stream, claim the track
  from the API, heartbeat while they work, and exit after it; a fresh worker
  takes their place.
- Translator worker added in Go (`apps/translator`), with `/health` and
  `/ready`, a Gemini probe command and a 41 MB image. Until LiveKit is
  connected, it reads and writes WAV files.
- The contract between the API and the workers as an OpenAPI document, with Go
  and TypeScript types generated from it.
- Redis added to Docker Compose, and the translator workers as the
  `translator` profile; new settings in `.env.example`.
- Translator CI workflow: Go checks and tests (with Redis), contract drift, the
  API tests against Postgres and Redis, and the worker image build.
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
- CI/CD page: the docs checks, publishing the site, running and fixing the
  checks, what's enforced today, and the planned code CI (YGP-77).
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
