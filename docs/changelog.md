# Changelog

## Unreleased

- Proposed ADR-0022: architecture tests, go-arch-lint for the worker and
  dependency-cruiser for the API, run in CI on every pull request; lists which
  rules each one checks and why (YGP-110).
- Proposed ADR-0023: LiveKit's public address. A Hetzner VPS as the relay, a
  WireGuard sidecar in the LiveKit pod, and Caddy for signaling, with the move
  to a public cloud after release for higher availability (YGP-109).
- CI/CD page: "What's enforced today" now matches the imported ruleset (pull
  request and one approval on `main` and `testing`; checks and `development`
  not enforced yet) (YGP-76).
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
