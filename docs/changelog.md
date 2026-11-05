# Changelog

## Unreleased

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
- Postgres in Docker Compose for local development, with a named volume and a
  health check; settings in `.env.example` (YGP-61).
