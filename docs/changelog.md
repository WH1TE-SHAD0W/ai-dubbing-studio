# Changelog

## Unreleased

- LiveKit rooms in the API: room names from the session and language
  (ADR-0020), creating a session's source room and one output room per
  language, and deleting them in two steps; new `LIVEKIT_` settings, passed to
  the `api` container. Tested against a real LiveKit, also in CI (YGP-69).
- Code checks on every pull request: typecheck, tests with a Postgres
  database, and build (YGP-75).
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
