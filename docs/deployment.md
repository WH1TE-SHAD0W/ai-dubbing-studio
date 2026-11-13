# Deployment and runbook

How the app is deployed, updated and rolled back. The operational runbook is
[Roll back](#roll-back), [Check a deploy](#check-a-deploy) and the
[Rollback drill](#rollback-drill). Some of it is built and some
is still planned, so each part says which:

- **Built** means the code is on `development`. It reaches `main`, and this
  site, when the feature is released (see the
  [branching strategy](branching-strategy.md)).
- **Planned** means it is in Jira but not built yet.

## Where it runs

| | Where | Status |
|---|---|---|
| **Local** | Docker Compose, on a developer's machine | Built |
| **Test** | A K3s (lightweight Kubernetes) cluster of six VMs (YGP-53, YGP-87), namespace `ads-test`, kept up to date by Argo CD (YGP-82), at <https://test.glossia.ie> | Built |
| **Production** | The same cluster, namespace `ads-prod`, at `glossia.ie` | Planned: its Argo CD application is written but not applied yet |
| **Backup** | Docker Compose on a VM, if K3s wasn't ready in time (YGP-84) | Not needed: the test environment was running on K3s by the 12 November cut-off |

Compose settings are in `.env`; see the
[Setup Guide](setup-guide.md#settings-env). On K3s, the settings are in the
deploy repository and the secrets are Kubernetes Secrets (see
[Where the manifests live](#where-the-manifests-live)).

### The cluster

The cluster has three server nodes, which run Kubernetes itself, and three
agent nodes. The app (the API, Postgres, Redis, LiveKit and the workers) runs
only on the agent nodes: every Deployment and StatefulSet skips nodes with the
`control-plane` label, so a busy database can't slow the cluster down.

### How visitors reach it

Nothing on the cluster is opened to the internet. Both public paths start
from inside and connect out:

```mermaid
flowchart LR
    browser["Browser or phone"] -- "HTTPS:<br>test.glossia.ie" --> cf["Cloudflare"]
    cf -- "Cloudflare Tunnel" --> cfd["cloudflared<br>(2 pods)"]
    cfd --> traefik["Traefik<br>(K3s ingress)"]
    traefik --> api["api<br>(ads-test)"]
    browser -- "wss + media:<br>livekit.test.glossia.ie" --> relay["Hetzner relay<br>(Caddy, WireGuard)"]
    relay -- "WireGuard tunnel" --> lk["livekit pod<br>(WireGuard sidecar)"]
    api -. "rooms and tokens<br>(inside the cluster)" .-> lk
```

- **The app and its API** go through a **Cloudflare Tunnel** (YGP-92). Two
  `cloudflared` pods keep the tunnel open; Cloudflare serves HTTPS with its own
  certificate and passes requests to Traefik, which sends each host name to its
  environment. `/internal` (the workers' API) is refused at the Ingress.
- **LiveKit's audio** can't go through that tunnel, which carries only HTTP. A
  WireGuard sidecar in the LiveKit pod dials out to a small relay VM at Hetzner,
  which serves `livekit.test.glossia.ie` with Caddy and forwards the media ports
  (7881/TCP and 7882/UDP for test) through the tunnel
  ([ADR-0023](https://wh1te-shad0w.github.io/ai-dubbing-studio/adr/0023-livekit-public-endpoint/), YGP-109). The API gives
  browsers this address as `LIVEKIT_PUBLIC_URL`. The API and the workers reach
  LiveKit directly inside the cluster.
- **The Argo CD UI** is only on the LAN (and over Tailscale), on port 8443 of
  any node, never through the tunnel.

## Components

| Component | Status | What it does | Decision |
|---|---|---|---|
| `postgres` | Built | Host accounts, logins, sessions and translation tracks, on the `postgres-data` volume | [ADR-0002](adr/0002-session-and-account-storage.md) |
| `api` | Built | The Hono API: serves the built app, host logins (Better Auth), sessions, translation tracks, and LiveKit rooms and tokens | [ADR-0012](adr/0012-serving-pwa-bundle.md), [ADR-0015](adr/0015-auth-library.md) |
| `redis` | Built | Hands translation jobs to the workers through a Redis Stream | [ADR-0018](adr/0018-autoscaling-architecture-of-translation-container.md) |
| `livekit` | Built | Carries the host's audio into a source room, and each language's translation out to listeners. The host's mic, the listener page and the translator workers use it (YGP-70) | [ADR-0001](adr/0001-audio-fan-out.md), [ADR-0013](adr/0013-sfu-client.md), [ADR-0020](adr/0020-input-audio-stream.md) |
| `translator` | Built (Compose and K3s) | Go workers, each serving one track (one language of one session) through Gemini. Started only with the `translator` Compose profile | [ADR-0018](adr/0018-autoscaling-architecture-of-translation-container.md), [ADR-0019](adr/0019-translation-worker-runtime.md) |

The proposed decision records are listed in the [ADR index](adr/index.md).

### The containers in Compose

| Container | Built from | Port |
|---|---|---|
| `postgres` | `postgres:18-alpine` | 5432, published on `127.0.0.1` only |
| `api` | `apps/api/Dockerfile` (Node 24 Alpine) | 3000 inside, `API_PORT` (default 3000) on `127.0.0.1` |
| `redis` | `redis:8-alpine` | 6379, on `127.0.0.1` only |
| `livekit` | `livekit/livekit-server` | 7880 (HTTP and WebSocket), 7881 (TCP) and 7882/udp (media), on `LIVEKIT_BIND` (default `127.0.0.1`) |
| `translator` | `apps/translator/Dockerfile` (Go) | None: it only connects out, to Redis, the API and Gemini |

- The API starts once Postgres is healthy, and creates or updates its tables
  before it accepts requests.
- Every container has a health check. The API's uses `GET /ready`, which also checks that
  Postgres answers; `GET /health` only checks that the process runs.
- All of them restart automatically unless stopped by hand.
- The API runs as the non-root `node` user, and stops cleanly on `SIGTERM`: it
  finishes open requests and closes the database connections, within 8 seconds.

### The API image

`apps/api/Dockerfile` is built from the repository root, as it needs the whole
pnpm workspace:

```bash
docker build -f apps/api/Dockerfile -t ai-dubbing-studio-api .
```

It builds in two stages:

1. **Build**: installs the workspace with pnpm, builds the app (`apps/web/dist`)
   and bundles the API into one file with esbuild.
2. **Runtime**: Node 24 Alpine with just that file and the built app. No
   `node_modules`, pnpm or build tools, about 250 MB in all, most of it Node.

## How a release reaches the cluster

Git says what should run, and Argo CD makes the cluster match it. Nobody
deploys to the cluster by hand.

```mermaid
flowchart LR
    pr["PR: development → testing<br>(checks + approval)"] --> merge["Merge into testing"]
    merge --> build["Images workflow<br>(YGP-52)"]
    build --> hub["Docker Hub:<br>testing + commit SHA"]
    hub --> iu["Argo CD Image Updater<br>(checks every 15 min)"]
    git["Deploy repo:<br>overlays/test (YGP-81)"] --> argo["Argo CD<br>(YGP-82)"]
    iu --> argo
    argo --> test["Test environment<br>(namespace ads-test)"]
```

### Step by step

| Step | Status | Where to see it |
|---|---|---|
| 1. Open a pull request from `development` into `testing`, listing what's being promoted. | Built | The pull request |
| 2. The checks run: [code checks](ci-cd.md#code-checks), [image build](ci-cd.md#image-build), the docs checks and the security scan (YGP-78). Another team member approves. | Built | The **Checks** tab of the pull request |
| 3. Merge. The Images workflow builds the API and worker images and pushes each to Docker Hub as `testing` and as the full commit SHA. | Built | **Actions → Images** for the merge commit, then the image's **Tags** page on Docker Hub |
| 4. Within about 15 minutes, Argo CD Image Updater sees that `testing` points to a new image, and sets that image's digest on the `ads-test` application. Argo CD then rolls the pods onto it. | Built | The Image Updater log shows `images_updated`; the test application shows **Synced** and **Healthy** in Argo CD |
| 5. [Check the deploy](#check-a-deploy). | Built | See below |

Production (planned) will come from `main` into the `ads-prod` namespace, but
each release is pinned to its commit SHA by a reviewed pull request in the
deploy repository, not picked up automatically
([ADR-0021](adr/0021-how-we-deploy.md)).

| Branch | Image tag | Namespace |
|---|---|---|
| `testing` | `testing` | `ads-test` |
| `main` | `prod` | `ads-prod` |

So a test deployment never runs an image that hasn't been through `testing`,
and production never runs one that hasn't reached `main`.

### Where the manifests live

The Kubernetes manifests (YGP-81) describe what each environment runs. They
live in their own repository,
[ai-dubbing-studio-deploy](https://github.com/jamiemccourt800/ai-dubbing-studio-deploy):
a Kustomize `base` plus one overlay per environment (`overlays/test`,
`overlays/prod`), which sets the namespace, the image tag and the host name.
Its README covers the Secrets to create on the cluster, Argo CD, Image
Updater, the Cloudflare Tunnel, the LiveKit relay, and how to try it locally.

The manifests are kept apart from the code, as Argo CD recommends. Changing
what runs never triggers this repository's CI, and the deploy repository's
history is a log of what ran when. Neither repository holds any secrets: they
are Kubernetes Secrets, created by hand on the cluster.

**How a new image is picked up** ([ADR-0021](adr/0021-how-we-deploy.md)): with
the moving `testing` tag the manifests never change, so Argo CD Image Updater
watches Docker Hub and sets the new image's digest on the `ads-test`
application. It checks every 15 minutes and logs in with a read-only Docker Hub
token, because Docker Hub limits how often a cluster may pull without one.

## Roll back

### With Docker Compose (built)

Compose builds the images from the code in the folder, so rolling back means
going back to an earlier commit and rebuilding:

```bash
git log --oneline              # find the last commit that worked
git checkout <commit>
docker compose up --build -d
```

Then [check the deploy](#check-a-deploy). When the fix is released, return to
the branch with `git switch main` and deploy again.

The database is not rolled back. The API only ever adds tables and columns, so
older code still runs against them. To undo data changes too, restore the
backup taken before the update.

### On K3s (built, way 2 drilled)

Three ways back, from the normal one to the emergency one. Whichever you use,
[check the deploy](#check-a-deploy) afterwards and tell the team what was
rolled back and why.

**For ways 2 and 3, pause Image Updater and remove its digest first.** Image
Updater writes the newest `testing` digest onto the Argo CD application, and
that wins over the tag in Git, even while Image Updater is paused (the
[drill](#rollback-drill) found this). Left in place, a pin in Git does nothing,
and a running Image Updater moves the environment back within 15 minutes.
Pause it, remove its digest, roll back, and start it again once the fix is
released:

```bash
kubectl -n argocd scale deploy/argocd-image-updater-controller --replicas=0   # pause
kubectl -n argocd patch application ads-test --type json \
  -p '[{"op":"remove","path":"/spec/source/kustomize/images"}]'              # remove its digest
kubectl -n argocd scale deploy/argocd-image-updater-controller --replicas=1   # resume: it puts the digest back
```

**1. Revert in Git (the normal way).** Use it when there's time for a build
(a few minutes).

1. Find the merge that brought the bad change into `testing`:
   `git log --oneline --merges origin/testing`.
2. Revert it on a branch and open a pull request into `testing`:

    ```bash
    git switch -c revert/YGP-XX-what origin/testing
    git revert -m 1 <merge commit>
    git push -u origin revert/YGP-XX-what
    ```

3. Once it merges, new images are built from the reverted code, and Image
   Updater and Argo CD roll them out, as for any release.

The fix then goes through `development` as usual.

**2. Pin a known-good image (exact and quick).** Use it to go back to one
earlier commit's images straight away, without a build.

1. Find the last good commit SHA: on Docker Hub (the image's **Tags** page),
   or with `git log --oneline origin/testing`. Every pushed image is tagged
   with its full SHA.
2. In the deploy repository, change the tag in
   `overlays/test/kustomization.yaml` from `testing` to that SHA, and open a
   pull request:

    ```yaml
    images:
      - name: ai-dubbing-studio-api
        newName: glossia/ai-dubbing-studio-api
        newTag: <full commit SHA>
    ```

3. Once it merges, Argo CD syncs the namespace to that exact image.
4. When the fix is released, set the tag back to `testing` the same way.

A rollback pull request (branch `rollback/...`) doesn't have to wait for an
approval: the deploy repository's owner can merge it straight away, and the
other person reviews it afterwards. The deploy repository's README
("Urgent changes") has the rule. Whoever can't do that uses way 3.

**3. Roll back in Argo CD (emergency only).** Use it when the app is down and
a pull request would take too long.

1. Turn off automatic sync for the application. Argo CD won't roll back while
   it's on, and would sync the bad version again anyway.
2. In the Argo CD UI (`https://<any node's LAN address>:8443`), open the application, then **History and rollback**, and
   roll back to the last sync that worked. The CLI does the same:
   `argocd app rollback <application> <history ID>`.
3. Then do way 1 or 2 so Git matches the cluster, and turn automatic sync back
   on.

## Check a deploy

After every deploy or rollback.

### Compose check (built)

1. `docker compose ps` shows every container as `healthy`.
2. The health endpoints answer:

    ```bash
    curl http://localhost:3000/health   # {"status":"ok"}: the API runs
    curl http://localhost:3000/ready    # {"status":"ok"}: it can reach Postgres
    ```

    `/ready` answers `503` with `database unavailable` if Postgres can't be
    reached.

3. The app opens in a browser and a host can log in.
4. `docker compose logs api` shows no errors since the start.

### K3s check (built)

```bash
kubectl -n ads-test rollout status deploy/api    # waits until the new pods are ready
kubectl -n ads-test get pods                     # every pod Running and ready (livekit 2/2, with its sidecar)
kubectl -n ads-test get deploy api -o jsonpath='{.spec.template.spec.containers[0].image}'
kubectl -n argocd get applications               # SYNC STATUS Synced, HEALTH Healthy
kubectl -n ads-test logs deploy/api --since=10m  # no errors since the update
```

1. The image shown is the one you meant: the newest `testing` digest, or the
   pinned SHA.
2. `https://test.glossia.ie/health` and `/ready` answer `{"status":"ok"}`.
3. The app opens in a browser and a host can log in.

A new pod only gets traffic once its readiness check (`/ready`) passes, so the
old pods keep serving until then.

## Rollback drill

YGP-83 asks for a rollback to be tried once on the test environment, so the
steps are known to work before they're needed.

**Status: done on 13 November 2026, with way 2.**

What we did:

1. Noted the images test ran: the release from #72 (the LiveKit worker).
2. Paused Image Updater and removed its digest from the application.
3. Pinned test to the images from `5b35d50`, the `testing` release before
   #72 (deploy #18), and timed it from the merge.
4. [Checked the deploy](#check-a-deploy): both Deployments on `5b35d50`, the
   workers on the older image's digest, `/health` and `/ready` OK.
5. Set the tag back to `testing` (deploy #20) and resumed Image Updater, which
   put the newest digest back within a minute. Test was back on #72's images,
   Synced and Healthy.

| | Result |
|---|---|
| Date | 13 November 2026 |
| Change rolled back | The `testing` release from #72 (LiveKit worker), back to `5b35d50` |
| Way used | 2: pin a known-good image in the deploy repository |
| Time from merge to healthy | 18 seconds (images already on the nodes) |
| What we learned | Image Updater's digest on the application wins over a pin in Git, even while it's paused, so it has to be removed too (now in the steps above). A rollback that waits for an approval isn't quick: the deploy repository's owner can now merge a rollback straight away. |

## Back up the database

The `postgres-data` volume holds every host account. To save a copy to a file:

```bash
docker compose exec postgres pg_dump -U dubbing dubbing > backup.sql
```

Use the `POSTGRES_USER` and `POSTGRES_DB` from `.env` if they differ.
`docker compose down -v` deletes the volume, so never use `-v` on a server.

On K3s, the database is on a volume on the node's disk. To save a copy:

```bash
kubectl -n ads-test exec postgres-0 -- pg_dump -U dubbing dubbing > backup.sql
```

## Things to know

- **HTTPS:** the microphone only works in a secure context. On K3s, Cloudflare
  serves HTTPS (see [How visitors reach it](#how-visitors-reach-it)). Compose
  doesn't include it, so on a server put your own HTTPS reverse proxy (for
  example Caddy or nginx) in front of the `api` container. Either way, set
  `BETTER_AUTH_URL` to the https address, so the login cookie is `Secure`.
- **List any proxy in `TRUSTED_PROXIES`**, so rate limits see each client's real
  IP. Without it, every visitor seems to come from the proxy and they all share
  one limit of 5 logins a minute. On K3s it is the pod network (`10.42.0.0/16`),
  where Traefik runs.
- **Both ports are published on `127.0.0.1` only**, so only that machine (and a
  reverse proxy on it) can reach them.
- **Secrets stay in `.env`**, which is git-ignored: the Postgres password and
  `BETTER_AUTH_SECRET`. Changing the secret logs every host out.
- **Back up the `postgres-data` volume**: it holds every host account.
  `docker compose down -v` deletes it.
- **More than one API container works**: logins and rate limits are kept in
  Postgres, not in memory. Copies that start together don't clash over the
  tables either: the table updates run under one Postgres lock, so the second
  copy waits for the first (see
  [Database migrations](setup-guide.md#database-migrations)).

## Still to be decided

- **The worker pool's size and limits** (ADR-0018 follow-up). The test
  environment runs a fixed pool of two workers for now.

Decided since this page was first written: how we deploy and how a new image
reaches the cluster ([ADR-0021](adr/0021-how-we-deploy.md)), secrets (created
by hand on the cluster), and HTTPS and the public address (the Cloudflare
Tunnel, and the LiveKit relay in [ADR-0023](https://wh1te-shad0w.github.io/ai-dubbing-studio/adr/0023-livekit-public-endpoint/)).
