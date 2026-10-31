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
captions reach listeners, whether LiveKit rooms are per session or per language,
whether the prototype runs on Docker Compose or Kubernetes, and how the dubbing
container verifies the host.

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
  H-->>C: 1. mic audio (path to be decided)
  C->>G: 2. host audio (1 stream per language)
  G-->>C: 3. translated audio + captions
  C->>K: 4. publish 1 audio track per language
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
  A-->>L: LiveKit token
  L->>K: connect with the token (WebRTC)
  K-->>L: audio track for the chosen language
```

Listeners have no account. They only need the join code.

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

The details are in ADR-0003.

## Why it's built this way

| Part | Decision |
|---|---|
| LiveKit for listener audio | [ADR-0001](adr/0001-audio-fan-out.md) |
| PostgreSQL | [ADR-0002](adr/0002-session-and-account-storage.md) |
| Hono for the API | [ADR-0007](adr/0007-backend-framework.md) |
| Separate dubbing container | [ADR-0008](adr/0008-separated-container.md) |
| Starting a session in the dubbing container | [ADR-0009](adr/0009-translation-engine-communication.md) |
| One React PWA | [ADR-0010](adr/0010-mobile-native.md) |
| Audio on phones | [ADR-0011](adr/0011-audio-handling.md) |
| Hono serves the app | [ADR-0012](adr/0012-serving-pwa-bundle.md) |
| The app's pages | [ADR-0014](adr/0014-pages.md) |

Decisions still in review are listed in the [ADR index](adr/index.md) once they are merged.

## Data model

PostgreSQL stores host accounts, logins, sessions and their target languages. The
reasons are in [ADR-0002](adr/0002-session-and-account-storage.md) (storage) and
ADR-0003 (host logins). Host accounts and logins use the tables Better Auth
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
  peak listener count to show where the Gemini cost goes.
- Deleting a live event deletes its languages; deleting a host deletes their
  logins. Ended events are deleted after 30 days, and expired logins daily.
- **Not stored:** audio, captions or transcripts, listener identities, and live
  state such as connections.
