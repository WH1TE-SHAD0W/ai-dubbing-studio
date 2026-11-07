# 0021. How we deploy: Argo CD on K3s, from a separate deploy repository

- **Status:** Proposed
- **Date:** 2026-11-06
- **Deciders:** Jamie McCourt
- **Ticket:** YGP-80

## Context

The app runs on one K3s server (YGP-87), with a test and a production
environment. The CI already builds the images and pushes them to Docker Hub,
tagged with the commit SHA plus `testing` or `prod` (YGP-52, the
[CI/CD page](../ci-cd.md)). What's missing is how a merged change gets onto the
cluster.

- **The server is behind Tailscale,** so GitHub can't reach it: anything that
  deploys has to pull from inside, not be pushed to from outside.
- **Two environments, one node:** `testing` → test, `main` → production
  ([branching strategy](../branching-strategy.md)).
- **No secrets in Git,** in any repository.
- **A two-person team with a deadline:** the prototype is due on 17 November,
  so there must be a fallback if the cluster isn't ready.

ADR-0018 to ADR-0020 decide how the translation workers and LiveKit work. This
ADR only covers delivery: what puts them on the cluster.

## Options considered

1. **Argo CD on K3s** (pull-based GitOps).
    - Pros: pulls from GitHub, so nothing needs to reach the server; puts
      back anything changed by hand; a web UI that shows what runs and lets you
      roll back to an earlier sync; the most used GitOps tool.
    - Cons: one more component on the server (a few hundred MB of memory).
2. **Flux on K3s** (pull-based GitOps).
    - Pros: the same pull model, and lighter than Argo CD.
    - Cons: no built-in UI, so what's running is harder to see and to show in
      a demo.
3. **Push from GitHub Actions** (`kubectl` or Helm over a Tailscale connection).
    - Pros: no extra component on the server.
    - Cons: GitHub would hold cluster credentials and a Tailscale key; nothing
      notices or fixes a change made by hand; harder to roll back.
4. **Docker Compose, pulled on a timer** (a script or Watchtower).
    - Pros: the simplest; already how the app runs locally.
    - Cons: no rollout or rollback tooling, and it isn't the Kubernetes setup
      the project is meant to show.

Where the manifests live:

- **A folder in the app repository.** One repository, but if the CI writes image
  tags into it, each of those commits triggers the CI again.
- **A separate deploy repository** (Argo CD's recommendation). The app's CI is
  never retriggered by a deploy change, the deploy repository's history is a log
  of what ran when, and config can change without an app release.

## Decision

- **Argo CD on the K3s server** (option 1), with one Argo CD application per
  environment, each syncing automatically (YGP-82).
- **The manifests live in their own public repository,**
  [`ai-dubbing-studio-deploy`](https://github.com/jamiemccourt800/ai-dubbing-studio-deploy)
  (YGP-81): a Kustomize base plus `test` and `prod` overlays, which set the
  namespace, the image tag and the host name. Its README covers the layout and
  the setup.
- **Secrets are created on the cluster by hand**, three per environment
  (`postgres`, `livekit`, `api`), and never kept in either repository.
- **One cluster-wide setting**: K3s's Traefik keeps visitors' real addresses
  (`externalTrafficPolicy: Local`), so the API's login rate limits work
  (ADR-0003).
- **Fallback (option 4):** if K3s with Argo CD isn't syncing the test
  environment by **Wednesday 11 November**, the prototype is demonstrated with
  Docker Compose instead (YGP-84), and this ADR is updated.

**Still open: how Argo CD picks up a new image.** With moving tags (`testing`,
`prod`), the manifests never change, so Argo CD needs a restart or Argo CD Image
Updater to notice a new image. With the CI pinning each commit SHA in the deploy
repository, every release is a commit there, which makes rollbacks exact, but
the app's CI needs a token that can push to the deploy repository. This is
decided in YGP-82 and recorded here.

## Consequences

### Good

- Nobody deploys by hand, and nothing outside needs to reach the server.
- What runs in each environment is written in Git, and a rollback is a revert
  there.
- Argo CD puts back anything changed on the cluster by hand.
- The manifests are checked on every pull request (rendered and validated
  against the Kubernetes schemas), and `main` of the deploy repository needs a
  reviewed pull request.

### Bad / trade-offs

- A second repository to keep in step with the code. A change that needs both,
  such as a new setting, takes two pull requests.
- Argo CD uses memory on a small server.
- The Secrets are made by hand, so a new environment needs the README's
  commands run once.

### Follow-up work

- YGP-82: install Argo CD and add an application per environment; decide how
  new images are picked up, and record it here.
- YGP-81: add Redis and the translation worker pool to the manifests, with the
  translation workers (ADR-0018).
- YGP-83: try a rollback on the test environment.
- YGP-84: the Compose fallback, only if the 11 November cut-off is missed.
