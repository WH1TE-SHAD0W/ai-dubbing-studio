# 0023. LiveKit's public address: a Hetzner relay, a WireGuard sidecar and Caddy

- **Status:** Proposed
- **Date:** 2026-11-11
- **Deciders:** Marek Culak
- **Ticket:** YGP-109 (part of YGP-53)

## Context

Browsers and phones must reach LiveKit (ADR-0001, ADR-0013) in two ways:

- **Signaling**: a WebSocket to LiveKit's port 7880. The app is served over
  HTTPS, so browsers only allow `wss://`, with a valid certificate. LiveKit
  doesn't serve TLS itself; it expects a proxy in front of it.
- **Media**: WebRTC audio, over UDP (7882 for test, 7892 for prod), with TCP
  (7881, 7891) as the fallback. UDP matters: over TCP a lost packet holds back
  everything behind it, the problem ADR-0001 moved away from.

The cluster can't take either from the internet directly:

- **The K3s VMs are on a LAN behind Tailscale** (ADR-0021), with no public
  address and no port we can open to the internet.
- **The Cloudflare Tunnel (YGP-92) only carries HTTP.** It already makes the
  app public, and could carry signaling, but not WebRTC media.
- **LiveKit's pod can move.** It runs on whichever node Kubernetes picks, and
  moves when a node fails or is drained. Until now its media ports were opened
  on that node (`hostPort`), which only works when the node itself is
  reachable.
- **No secrets in Git** (ADR-0021).
- **A small team with a deadline**: the prototype is due on 17 November, so
  the setup must be simple to build and to explain.

## Options considered

### Where the public address comes from

1. **A small VPS at Hetzner, as a relay.** It has a public IPv4 address and
   takes any port, UDP included. Media and signaling come in there and go
   through a tunnel to the cluster.
    - Pros: cheap (a few euros a month, billed by the hour) with a public IPv4
      address and 20 TB of traffic a month included in its EU locations, so
      media traffic doesn't add cost; data stays in the EU; a plain Ubuntu VM,
      set up with Ansible like the cluster.
    - Cons: one more machine to keep up to date, and all LiveKit traffic
      depends on it.
2. **A VM at AWS, Google Cloud or Azure.** Works the same way.
    - Cons: costs more for the same VM, and outgoing traffic is billed per GB.
      Media is most of our traffic.
3. **A NanoPi at home, as the relay.** The same relay setup (WireGuard,
   forwarding, Caddy) on a small ARM board on a team member's home
   connection, with the router forwarding the ports to it.
    - Pros: no monthly cost, since we own the hardware; WireGuard, nftables and
      Caddy all run on ARM, so the same Ansible role would work.
    - Cons: a home connection often has an address that changes, and LiveKit
      gives browsers a fixed IP (`--node-ip`), so every change breaks media
      until the config is updated; many home connections are behind
      carrier-grade NAT and have no public IPv4 address at all; home upload
      speed is usually much lower than download, and the relay sends every
      listener's audio upstream; the ISP may block ports 80 and 443 or not
      allow servers; calls would depend on one person's power, router and
      internet, and on the board itself; and the home's address would be
      public, with the home network one step from the internet.
4. **Open ports on the LAN's router.**
    - Cons: not possible on the network the VMs are on, and it would tie
      LiveKit to one node's address again.
5. **Media only over TCP, through something HTTP-based** (Cloudflare Tunnel,
   Tailscale Funnel).
    - Cons: they carry HTTP(S) or TCP, not UDP, so WebRTC would fall back to
      TCP, with the delays above.
6. **LiveKit Cloud.**
    - Cons: the media server leaves our deployment and becomes a paid service.
      ADR-0001 chose to run LiveKit ourselves.

### How traffic gets from the relay to LiveKit

1. **WireGuard.** In the Linux kernel, one UDP port, a short config with one
   key pair per end, and no server or account to depend on. It carries UDP and
   TCP alike.
2. **Tailscale.** Already used to reach the VMs, and also WireGuard underneath.
    - Cons: each pod would need a Tailscale auth key, which expires, and the
      tunnel would depend on Tailscale's coordination servers. We would get
      nothing we need over plain WireGuard.
3. **OpenVPN.**
    - Cons: runs in user space, so it's slower; needs a certificate authority;
      much more config than WireGuard.
4. **SSH reverse tunnel, or frp.**
    - Cons: SSH tunnels only carry TCP. frp carries UDP, but proxies each port
      in user space, and LiveKit would see every packet coming from frp.

### Where the tunnel ends in the cluster

1. **A WireGuard sidecar in the LiveKit pod.** The sidecar shares the pod's
   network, so the pod itself gets a tunnel address and LiveKit listens on it.
   The tunnel moves with the pod.
2. **WireGuard on every node.** The relay forwards to a node, which forwards to
   LiveKit's `hostPort`.
    - Cons: every node needs WireGuard and its own key; the relay has to know
      which node LiveKit is on, and its rules change every time the pod moves.
3. **A separate gateway pod** with WireGuard, forwarding to LiveKit's Service.
    - Cons: one more hop and one more thing that can fail, and UDP through a
      Service gets its address rewritten again.

### What serves signaling with TLS on the relay

1. **Caddy.** Gets Let's Encrypt certificates and renews them by itself, and
   proxies WebSockets with no extra settings: three lines per environment.
2. **nginx with certbot.**
    - Cons: certificates need certbot as a second tool. nginx won't start
      before the certificates exist, so the first run needs an extra step, and
      certbot edits the same config that Ansible writes. WebSockets need extra
      headers and a longer timeout set by hand. More to get right, for the same
      result.
3. **Signaling through the Cloudflare Tunnel** (a Traefik Ingress to
   `livekit:7880`).
    - Pros: no certificates on the relay, and ports 80 and 443 stay closed
      there.
    - Cons: signaling and media would take two different routes, so a call
      would depend on Cloudflare, Traefik and the relay at once; and it builds
      on YGP-92, which isn't merged yet.

## Decision

**A Hetzner VPS as the relay, a WireGuard sidecar in the LiveKit pod, and Caddy
on the relay for signaling.** The relay is LiveKit's only public address, for
both signaling and media, and the cluster opens no port for LiveKit.

| | Test | Prod |
|---|---|---|
| Signaling | `wss://livekit.test.glossia.ie` | `wss://livekit.glossia.ie` |
| Media ports on the relay | 7881 TCP, 7882 UDP | 7891 TCP, 7892 UDP |
| Pod's tunnel address | `10.8.0.2` | `10.8.0.3` |

The relay is `10.8.0.1` in the tunnel. Its public address is `46.62.226.178`.

**On the relay** (Ansible, `ansible/relay.yml` in the
[deploy repository](https://github.com/jamiemccourt800/ai-dubbing-studio-deploy)):

- WireGuard on UDP 51820, with one peer per environment. Each peer may only
  use its own tunnel address.
- nftables forwards each environment's media ports, unchanged, through the
  tunnel to its pod. The packets go in as `10.8.0.1`: the pod only accepts and
  answers `10.8.0.1` through the tunnel. Only that media goes into the tunnel,
  and only its replies come out, so the pods can't use the relay to reach the
  internet or each other.
- Caddy serves the two signaling names and passes them to port 7880 in the
  tunnel.
- The relay makes its own private key, which never leaves it.

**In the LiveKit pod** (`components/livekit-relay`, used by the test and prod
overlays):

- A WireGuard sidecar dials out to the relay. Only `10.8.0.1` goes through the
  tunnel (`AllowedIPs = 10.8.0.1/32`); everything else uses the cluster as
  before. The private key is a Secret made by hand; only public keys are in
  Git.
- It's a **native sidecar** (an init container that keeps running), so LiveKit
  starts only once the tunnel answers. LiveKit binds its UDP port to the
  addresses that exist when it starts: as an ordinary sidecar it started first
  and never heard media arriving through the tunnel, which the test below
  found.
- LiveKit tells browsers to send media to the relay (`--node-ip`). The
  `hostPort`s are gone.
- The pod is only Ready while the relay answers through the tunnel. LiveKit
  restarts with `Recreate`, so two pods with the same key never compete for
  the relay's one peer entry. On a failed node, the pod moves after 30 seconds
  instead of 5 minutes.
- The sidecar image is pinned to a tag and its digest, so no image updater
  changes it.

**Evidence.** With K3s v1.37.2 in Docker (two nodes), the relay playbook on an
Ubuntu 26.04 container, and a third container as the browser:

- the tunnel came up with a recent handshake, and only `10.8.0.0/24` went
  through it;
- TCP 7881 and UDP 7882 sent to the relay reached LiveKit's sockets in the
  pod, and LiveKit's 7880 answered through the tunnel;
- with WireGuard stopped on the relay, the pod stopped being Ready after 17
  seconds, and was Ready again 4 seconds after it started;
- when the pod moved to the other node, the tunnel was up again 5 seconds after
  the old pod was deleted (images already on the node), with no change on the
  relay;
- the pod's private key wasn't in any log or ConfigMap.

## Consequences

### Good

- LiveKit gets UDP media from the internet with no port opened on the LAN or
  the cluster.
- The tunnel follows the pod: rescheduling or draining a node needs no change
  on the relay.
- One public address for all of LiveKit, with certificates that renew
  themselves.
- The relay is rebuilt with one Ansible run, and the cluster side is in Git
  like the rest of the deployment.

### Bad / trade-offs

- **The relay is a single point of failure** for every call, and one more VM
  to patch and pay for. This is accepted for the prototype: once the platform
  is released, the plan is to move all of it to a public cloud for higher
  availability (see follow-up work).
- **Calls drop and rejoin when the pod moves**, because a call's media lives in
  one LiveKit process.
- **LiveKit sees every browser as `10.8.0.1`**, so its logs don't show
  browsers' addresses.
- **In-cluster clients, such as the translation workers, also send media via
  the relay**: LiveKit only gives out the relay's address. It works, but adds
  a round trip to Hetzner and uses its traffic.
- **Rebuilding the relay makes a new key**, so the pods' ConfigMap needs the
  new public key.
- **Two key pairs (test, prod) are made by hand**, and their private keys are
  created on the cluster as Secrets.

### Follow-up work

- Run `relay.yml` on the real VM, add the two DNS records (not proxied by
  Cloudflare) and the pods' keys, and check a call end to end with the real
  certificates (YGP-109).
- Decide whether the translation workers should reach LiveKit inside the
  cluster instead of through the relay.
- **After the release, move the whole platform to a public cloud** to make it
  more highly available: the cluster and LiveKit would then have public
  addresses of their own, so the relay, and with it this single point of
  failure, would no longer be needed. That move gets its own ADR, which
  supersedes this one.
