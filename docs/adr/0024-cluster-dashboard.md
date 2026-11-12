# 0024. Headlamp as the K3s cluster's dashboard

- **Status:** Proposed
- **Date:** 2026-11-12
- **Deciders:** Marek Culak
- **Ticket:** YGP-113 (part of YGP-53)

## Context

Today the only way to see what runs on the K3s cluster (ADR-0021) is SSH or
`kubectl`, through Tailscale. We want a web dashboard on the cluster that shows
the workloads in every namespace (`ads-test`, `ads-prod`, `cloudflared`,
`argocd`, `kube-system`), pod status and logs, and CPU and memory use, so the
team can check the cluster without typing commands.

What limits the choice:

- **It's an admin tool.** Whoever reaches it can read the cluster, and maybe
  change it. It must have a login and must not be on the public internet.
- **The Cloudflare Tunnel sends every host name to Traefik**
  (`cluster/cloudflared.yaml` in the deploy repository). Giving the dashboard
  an Ingress host with a DNS record at Cloudflare would make it public.
- **We reach the LAN through a Tailscale subnet router.** It shares the VMs'
  whole LAN (`10.108.152.0/21`) with the tailnet, so a team member on
  Tailscale can open any node's LAN address directly, with no port-forward.
  The nodes' firewall (ufw) only lets the LAN reach the cluster's own ports.
- **The VMs are small and shared** with the app, LiveKit and the translation
  workers, so the dashboard should be light.
- **It must still get security fixes**, since it can talk to the Kubernetes API.
- **No secrets in Git** (ADR-0021).
- **A small team with a deadline** (prototype due on 17 November): one Helm
  chart, nothing else to run or learn.

## Options considered

### Which dashboard

1. **Kubernetes Dashboard (v7, with Kong).** The UI that used to be the
   default for Kubernetes. Since 7.0.0 it installs only with Helm, as several
   containers (API, web, auth, metrics scraper) joined by a Kong gateway that
   the chart brings with it.
    - Pros: well known, many guides.
    - Cons: **archived on 21 January 2026** for lack of maintainers. The
      repository moved to `kubernetes-retired/dashboard` and gets no more
      security fixes, bug fixes or releases; SIG UI points users to Headlamp.
      An unpatched tool with access to the Kubernetes API is the worst place
      to have no fixes. It is also the heaviest option here: Kong is a whole
      API gateway, run only to put the dashboard's own containers behind one
      address, and it's one more thing to configure, debug (502s when Kong
      isn't ready) and keep up to date, next to Traefik, which we already run.
2. **Headlamp, in the cluster.** A Kubernetes UI under `kubernetes-sigs`,
   recommended by SIG UI in place of the Dashboard. One Helm chart
   (`headlamp/headlamp`) with one container; no gateway needed.
    - Pros: maintained, with regular releases; one pod, so light on the VMs;
      a plain Service, so it can be reached from the LAN without an Ingress
      or a public host name; login with a service account token or OIDC, and every action goes
      through Kubernetes RBAC, so a read-only token only lets you look; shows
      CPU and memory from metrics-server, which K3s already runs; plugins,
      such as one for Flux, if we ever want more.
    - Cons: younger than the Dashboard, so fewer guides; its own multi-cluster
      setup (a kubeconfig Secret) is more work, but we don't need it.
3. **Headlamp desktop app only.** The same UI as an app on each laptop, using
   the person's own kubeconfig, with nothing installed in the cluster.
    - Pros: nothing to run or secure on the cluster.
    - Cons: every team member installs and updates it, and the Windows builds
      aren't signed. It doesn't meet YGP-113, which asks for a dashboard on
      the VM. It stays available to anyone who prefers it, with the same
      kubeconfig.
4. **Rancher.** A full cluster management platform, from the makers of K3s.
    - Cons: far more than we need (users, projects, cluster provisioning). It
      needs cert-manager, takes several pods and a lot of memory, and becomes
      a large system of its own to run.
5. **Portainer.** A container management UI with Kubernetes support.
    - Cons: an extra agent in the cluster plus a server; some features are
      only in the paid edition; built around Docker first, Kubernetes second.
6. **Lens, Freelens or OpenLens.** Desktop apps for Kubernetes.
    - Cons: desktop only, like option 3, and Lens needs an account (and a paid
      licence for commercial use). Freelens is free, but adds nothing over the
      Headlamp desktop app.
7. **k9s.** A terminal UI.
    - Cons: not a web dashboard; it still needs a terminal and a kubeconfig.
      Good for whoever already uses `kubectl`, but not what YGP-113 asks for.
8. **Argo CD's UI**, already running (ADR-0021).
    - Pros: nothing new to install; shows each app's resources and pod logs.
    - Cons: shows only what Argo CD deploys (`ads-test`, `ads-prod`). The parts
      applied by hand once per cluster (`cluster/` in the deploy repository:
      cloudflared, Traefik settings) and `kube-system` aren't there, and it
      shows no CPU or memory.
9. **Grafana with Prometheus.**
    - Cons: graphs metrics over time, but doesn't list or manage workloads.
      A different job from this one, and two more heavy services to run.

### How we reach it

1. **`kubectl port-forward`.** Nothing exposed at all.
    - Cons: has to be started every time, needs `kubectl` and a kubeconfig,
      and stops when the terminal closes.
2. **A LAN-only port, through K3s's built-in load balancer (ServiceLB).** The
   Headlamp Service is `type: LoadBalancer` on its own port, and K3s opens that
   port on every node. Team members reach it through the subnet router.
    - Pros: always on, no `kubectl` needed; works while a node is down (any
      node answers); bypasses Traefik, so the Cloudflare Tunnel, which only
      goes to Traefik, can never carry it; ufw lets only the LAN in; no DNS,
      account or extra software.
    - Cons: plain HTTP. Traffic is encrypted by Tailscale up to the subnet
      router, but crosses the LAN unencrypted, token included.
3. **A Traefik Ingress with a LAN-only name** (such as `headlamp.ads.lan`) and
   an IP allow-list.
    - Cons: shares Traefik with the public sites, so its safety rests on the
      allow-list and on no one ever routing that name through the tunnel; no
      certificate for a `.lan` name either.
4. **A public host name through the Cloudflare Tunnel, behind Cloudflare
   Access** (a Cloudflare login in front of the page).
    - Pros: reachable from any browser, without Tailscale.
    - Cons: the access rule lives in the Cloudflare dashboard, not in Git; one
      mistake in it makes the dashboard public. Nobody needs it from outside
      the tailnet today.
5. **Tailscale's Kubernetes operator**, which makes Headlamp its own tailnet
   device with an HTTPS name.
    - Cons: one more operator and an OAuth secret, for what the subnet router
      already gives us.

## Decision

**Headlamp, installed in the cluster with its Helm chart, on a LAN-only port
through K3s's ServiceLB, reached through the Tailscale subnet router.**

- **Why not the Kubernetes Dashboard:** it's archived and gets no security
  fixes, and its Kong gateway adds a second proxy we don't need. Headlamp is
  the replacement SIG UI recommends, does the same job in one container, and
  is still maintained.
- **Install:** the `headlamp/headlamp` chart from
  `https://kubernetes-sigs.github.io/headlamp/`, with the chart version and
  image tag pinned (not `latest`), applied once per cluster like the rest of
  `cluster/` in the deploy repository.
- **Access:** the Headlamp Service is `type: LoadBalancer` on port 4466, so
  ServiceLB opens 4466 on every node. A team member on Tailscale opens
  `http://headlamp.ads.lan:4466`, where `headlamp.ads.lan` resolves to the
  nodes' LAN addresses, the same way as `k3s.ads.lan`. Port 4466 is opened in
  ufw to the LAN (`k3s_lan_cidr`) only, not added to the public ports. There
  is no Ingress and no DNS record at Cloudflare, so the dashboard isn't public.
  `kubectl port-forward` still works for anyone who prefers it.
- **Login:** a token from a ServiceAccount bound to the built-in `view`
  ClusterRole, made with `kubectl create token`, so it expires. `view` can't
  read Secrets or change anything. Changes still go through Git and Argo CD.
  No token is stored in Git.

## Consequences

### Good

- The team can see workloads, logs and resource use in every namespace from a
  browser, at a fixed address, with no command to run first.
- Nothing new is public: only the LAN, and through it the tailnet, can reach
  it, and the default login is read-only.
- One small pod and one chart, with no gateway beside Traefik.
- Uses a project that still gets security fixes.

### Bad / trade-offs

- **It needs Tailscale** (or being on the LAN), so it isn't reachable from a
  browser elsewhere.
- **Plain HTTP on the LAN:** the login token crosses the LAN unencrypted.
  Accepted for the prototype, since the token is read-only and expires;
  Headlamp can serve TLS itself if we need it later.
- **Anyone on the LAN can reach the login page**, not only the team. They
  still need a token to see anything.
- **Read-only by default**: restarting a pod or scaling from the UI needs a
  token with more rights, made by hand when needed.
- **Tokens expire**, so a new one is made each time (one command).
- **One more chart to keep up to date** on the cluster.

### Follow-up work

- Add Headlamp (with its LoadBalancer Service on 4466), its ServiceAccount and
  the `view` binding to `cluster/` in the deploy repository; open 4466 to the
  LAN in the Ansible firewall role; add `headlamp.ads.lan` next to
  `k3s.ads.lan`. Check it opens through the subnet router, lists the workloads
  and shows metrics, and write down how to open it in the deploy docs
  (YGP-113).
- If someone outside the tailnet needs it later, decide on a login in front of
  it (Cloudflare Access, OIDC, or an identity-aware proxy) before giving it a
  public host name.

## Sources

- [From Kubernetes Dashboard to Headlamp](https://kubernetes.io/blog/2026/06/01/dashboard-to-headlamp/),
  Kubernetes blog, 1 June 2026.
- [Archiving of Kubernetes Dashboard Project](https://groups.google.com/g/kubernetes-sig-ui/c/vpYIRDMysek),
  SIG UI mailing list.
- [kubernetes-retired/dashboard](https://github.com/kubernetes-retired/dashboard),
  the archived repository.
- [Kubernetes Dashboard 7.0.0 release notes](https://newreleases.io/project/github/kubernetes/dashboard/release/kubernetes-dashboard-7.0.0):
  Helm-only install with Kong.
- [Headlamp in-cluster installation](https://headlamp.dev/docs/latest/installation/in-cluster/).
- [kubernetes-sigs/headlamp](https://github.com/kubernetes-sigs/headlamp).
