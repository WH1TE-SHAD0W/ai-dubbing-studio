# 0021. How we deploy: Argo CD on K3s, from a separate deploy repository

- **Status:** Proposed
- **Date:** 2026-11-06
- **Deciders:** Jamie McCourt
- **Ticket:** YGP-80

## Context

The app runs on a K3s cluster (YGP-87: three servers and three agents), with a test and a production
environment. The CI already builds the images and pushes them to Docker Hub,
tagged with the commit SHA plus `testing` or `prod` (YGP-52, the
[CI/CD page](../ci-cd.md)). What's missing is how a merged change gets onto the
cluster.

- **The server is behind Tailscale,** so GitHub can't reach it: anything that
  deploys has to pull from inside, not be pushed to from outside.
- **Two environments, one cluster:** `testing` → test, `main` → production
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

### How a new image reaches the cluster (proposed, YGP-82)

The overlays use moving tags (`testing`, `prod`), so a new image doesn't
change the manifests and Argo CD doesn't notice it. Two facts narrow the
choice:

- **The deploy repository's `main` needs a reviewed pull request**, and nobody
  can skip that. Anything that writes the new image into Git on its own (CI or
  a bot) can't push to `main`: it could only open a pull request that a person
  approves for every release.
- **The cluster is behind Tailscale**, so GitHub can't reach it to restart
  anything.

| Option | How | Pros | Cons |
|---|---|---|---|
| A. **Argo CD Image Updater, digest, written to Argo CD** | Image Updater (v1.3) runs next to Argo CD, checks the registry every few minutes, and when the `testing` tag points to a new image it sets that image's digest on the application | Fully automatic; needs no token anywhere; works behind Tailscale, since it pulls | The image in use isn't written in Git (it's in the application); one more small component |
| B. **Image Updater, written to Git** | The same, but it commits the new digest to the deploy repository | Every release is a commit, so the deploy history shows exactly what ran | Needs a write key for the deploy repository, and branch protection stops it pushing to `main`, so it would need a branch of its own for Argo CD to follow |
| C. **The app's CI pins the commit SHA** | After pushing an image, the Images workflow opens a pull request in the deploy repository with the new SHA | Exact, and reviewed | A token for the deploy repository in the app's CI, and a manual approval for every release |
| D. **Restart by hand** | `kubectl -n ads-test rollout restart deploy/api` (the overlays always pull the image) | Nothing to install | Not automatic, so it doesn't meet YGP-82 |

**Proposed: A** for the prototype, with D as the fallback until it's set up.
It's the only option that is automatic without a token or a manual approval
per release.

What it changes for rolling back (see the
[Deployment page](../deployment.md#roll-back)):

- **Reverting in Git** (in this repository) still works as before: the revert
  builds a new `testing` image, and Image Updater rolls the cluster onto it.
- **Pinning a known-good image in the deploy repository** only takes effect
  once Image Updater is paused for that application, because its digest wins
  over the tag in Git. Pause it, pin, and turn it back on after the fix.

### Follow-up work

- YGP-82: Argo CD is installed and both applications are written (deploy
  repository #5). Left: agree on option A above, install Image Updater, then
  mark this ADR accepted.
- YGP-81: add Redis and the translation worker pool to the manifests, with the
  translation workers (ADR-0018).
- YGP-83: try a rollback on the test environment.
- YGP-84: the Compose fallback, only if the 11 November cut-off is missed.
