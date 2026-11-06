# Changelog

## Unreleased

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
