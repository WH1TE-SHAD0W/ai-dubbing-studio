# Architecture

This is the **target architecture for the final prototype**. It isn't built yet:
the [Setup Guide](setup-guide.md) and [API](api.md) describe the app as it works
today. The reasons for each choice are in the [decision records](adr/index.md).

## Overview

The host speaks once; every listener hears them in their chosen language.

- The **Hono API** handles logins and sessions, stores them in PostgreSQL, and
  serves the app.
- The **dubbing container** holds **one translation stream per target language**,
  using Gemini, and publishes one audio track per language to LiveKit.
- **LiveKit** forwards each listener only the language they picked.

Cost grows with the number of languages, not listeners.

**Still to be decided:** how the host's mic reaches the dubbing container, how
captions reach listeners once audio moves to LiveKit (today they use the
WebSocket), whether the prototype runs on Docker Compose or Kubernetes, and how
the dubbing container verifies the host.

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 90, "rankSpacing": 70}}}%%
flowchart TB
  Host["Host (PWA)"]
  Listener["Listeners (PWA)"]

  subgraph Platform["Our platform"]
    API["Hono API<br/>logins, sessions, serves the app"]
    DB[("PostgreSQL")]
    Dubbing["Dubbing container<br/>1 translation stream per language"]
    SFU["LiveKit<br/>SFU: selective forwarding unit"]
  end

  Gemini["Gemini Live Translate API"]

  Host -- "log in, create session" --> API
  Listener -- "join, get LiveKit token" --> API
  API <-- "accounts, sessions" --> DB
  API -- "start session" --> Dubbing
  Host -. "1. mic audio (path to be decided)" .-> Dubbing
  Dubbing <-- "2. audio / 3. translation" --> Gemini
  Dubbing -- "4. 1 audio track per language" --> SFU
  SFU -- "5. chosen language (WebRTC)" --> Listener
```

For more detail on each part, see [Architecture layers](architecture-layers.md).

## Step by step

```mermaid
sequenceDiagram
  participant H as Host (PWA)
  participant A as Hono API
  participant D as PostgreSQL
  participant C as Dubbing container
  participant G as Gemini Live Translate
  participant K as LiveKit (SFU)
  participant L as Listeners (PWA)
  H->>A: create session
  A->>D: save session details
  A->>C: start session (languages, provider)
  C->>K: create 1 room per language
  K-->>C: room IDs
  C-->>A: room ID per language
  A->>D: save room ID per language
  H-->>C: 1. mic audio (path to be decided)
  C->>G: 2. host audio (1 stream per language)
  G-->>C: 3. translated audio + captions
  C->>K: 4. publish each language's audio to its room
  K-->>L: 5. forward the listener's language (WebRTC)
```

An **SFU (selective forwarding unit)** receives each audio track once and forwards
it to every listener who subscribed to it, without decoding or mixing. Listeners
connect to it over **WebRTC**, which is built for real-time media.

### A listener joins

```mermaid
sequenceDiagram
  participant L as Listener (PWA)
  participant A as Hono API
  participant D as PostgreSQL
  participant K as LiveKit (SFU)
  L->>A: open link or enter join code
  A->>D: find the live session by join code
  D-->>A: title and languages
  A-->>L: session details and languages
  L->>A: choose language, ask for a LiveKit token
  A-->>L: LiveKit token and LiveKit's public address
  L->>K: connect with the token, through the relay (WebRTC)
  K-->>L: audio track for the chosen language
```

Listeners have no account. They only need the join code. On test, the listener
reaches the API at `test.glossia.ie` and LiveKit at `livekit.test.glossia.ie`,
through the relay (see [Networking](#networking-test)).

### A host logs in

```mermaid
sequenceDiagram
  participant H as Host (PWA)
  participant A as Hono API (with Better Auth)
  participant D as PostgreSQL
  H->>A: log in (email, password)
  A->>D: find user and account by email
  A->>A: check the password (Argon2id)
  A->>D: save the login (expires in 12 hours)
  A-->>H: cookie with the login token
  H->>A: later requests, with the cookie
  A->>D: check the login exists and hasn't expired
```

The details are in [ADR-0003](adr/0003-host-authentication.md).

## Networking (test)

This part runs today on the test environment. The cluster sits on a LAN with no
open ports, so browsers reach it by two public paths, both dialled out from
inside the cluster:

- **The app and the API** at `test.glossia.ie`, through a Cloudflare Tunnel.
- **LiveKit** at `livekit.test.glossia.ie`, through a Hetzner VPS (the relay)
  and a WireGuard tunnel ([ADR-0023](adr/0023-livekit-public-endpoint.md)).

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 60, "rankSpacing": 80}}}%%
flowchart LR
  Browser["Browser<br/>(host or listener)"]

  Edge["Cloudflare<br/>test.glossia.ie<br/>HTTPS, Cloudflare certificate"]

  subgraph Relay["Hetzner VPS (relay)"]
    Caddy["Caddy<br/>livekit.test.glossia.ie<br/>Let's Encrypt certificate"]
    NFT["nftables<br/>7881/tcp, 7882/udp"]
  end

  subgraph Cluster["K3s cluster (LAN, no open ports)"]
    CFD["cloudflared<br/>2 copies"]
    Traefik["Traefik<br/>routes by host name"]
    API["Hono API"]
    Translator["Translator"]
    LK["LiveKit pod<br/>WireGuard sidecar"]
  end

  Browser -- "app and API<br/>(HTTPS, WebSockets)" --> Edge
  Edge -- "Cloudflare Tunnel" --> CFD
  CFD --> Traefik
  Traefik --> API
  Browser -- "signaling<br/>wss://livekit.test.glossia.ie" --> Caddy
  Browser -- "media (WebRTC)" --> NFT
  Caddy -- "WireGuard tunnel<br/>to port 7880" --> LK
  NFT -- "WireGuard tunnel<br/>same ports" --> LK
  API -- "ws://livekit:7880" --> LK
  Translator -- "ws://livekit:7880" --> LK
```

- **Cloudflare** ends HTTPS and passes requests, WebSockets too, through the
  tunnel that `cloudflared` keeps open from the cluster. Traefik sends each
  host name to its environment's API (YGP-92).
- **The relay** serves LiveKit's signaling through Caddy and forwards media on
  UDP 7882 and TCP 7881. LiveKit tells browsers to send media to the relay's
  address. The WireGuard sidecar dials out to the relay, so the tunnel follows
  the pod to whichever node it runs on.
- **Inside the cluster** the API and the translator reach LiveKit directly at
  `ws://livekit:7880`, without going through the relay.

The [Deployment page](deployment.md#livekits-public-address-test) has the
details of the relay.

## Why it's built this way

| Part | Decision |
|---|---|
| LiveKit for listener audio | [ADR-0001](adr/0001-audio-fan-out.md) |
| PostgreSQL | [ADR-0002](adr/0002-session-and-account-storage.md) |
| Host logins | [ADR-0003](adr/0003-host-authentication.md) |
| Hono for the API | [ADR-0007](adr/0007-backend-framework.md) |
| Separate dubbing container | [ADR-0008](adr/0008-separated-container.md) |
| Starting a session in the dubbing container | [ADR-0009](adr/0009-translation-engine-communication.md) |
| One React PWA | [ADR-0010](adr/0010-mobile-native.md) |
| Audio on phones | [ADR-0011](adr/0011-audio-handling.md) |
| Hono serves the app | [ADR-0012](adr/0012-serving-pwa-bundle.md) |
| LiveKit client in the app | [ADR-0013](adr/0013-sfu-client.md) |
| The app's pages | [ADR-0014](adr/0014-pages.md) |
| Better Auth for host logins | [ADR-0015](adr/0015-auth-library.md) |
| Schemas and validation | [ADR-0016](adr/0016-schema-validator.md) |
| Dubbing container framework and runtime | [ADR-0017](adr/0017-translation-plane.md) |

Decisions still in review are listed in the [ADR index](adr/index.md) once they are merged.

## Data model

PostgreSQL stores host accounts, logins, sessions and their target languages. The
reasons are in [ADR-0002](adr/0002-session-and-account-storage.md) (storage) and
[ADR-0003](adr/0003-host-authentication.md) (host logins). Host accounts and logins use the tables Better Auth
creates (`user`, `account`, and its `session` table, renamed to `logins`); only
their main fields are shown. Better Auth also creates `verification` and, because
rate limits are kept in the database, `rateLimit`; neither is drawn here.

```mermaid
erDiagram
  user ||--|| account : "signs in with"
  user ||--o{ logins : "is logged in by"
  user ||--o{ sessions : runs
  sessions ||--|{ session_languages : "is translated into"

  user {
    text id PK
    text email UK
    text name "display name"
    timestamptz createdAt
  }
  account {
    text id PK
    text userId FK
    text providerId "credential"
    text password "argon2id$m$t$p$salt$hash"
  }
  logins {
    text id PK
    text token UK "sent in the cookie"
    text userId FK
    timestamptz expiresAt
  }
  sessions {
    text id PK "random, used in URLs"
    text host_id FK
    text join_code "unique while not ended"
    text title
    text source_lang
    text status "draft, live or ended"
    timestamptz created_at
    timestamptz started_at "null until live"
    timestamptz ended_at "null until ended"
    text end_reason
  }
  session_languages {
    text session_id PK, FK
    text lang PK
    text livekit_room_id "set when the session starts"
    int peak_listeners
  }
```

- **user:** one row per host account.
- **account:** how a host signs in. For email and password, it holds the
  password, stored only as an Argon2id hash.
- **logins:** one row per logged-in browser. Better Auth calls this table
  `session`; it is renamed so "session" always means a live event. Rows expire
  after 12 hours.
- **sessions:** one row per live event, owned by a host. `join_code` only has to
  be unique among sessions that haven't ended, so short codes can be reused.
- **session_languages:** each target language of a session, listed once, with its
  peak listener count to show where the Gemini cost goes. Each language has its
  own LiveKit room; its ID is stored here so listeners can be sent to the right room.
- Deleting a live event deletes its languages; deleting a host deletes their
  logins. Ended events are deleted after 30 days, and expired logins daily.
- **Not stored:** audio, captions or transcripts, listener identities, and live
  state such as connections.
