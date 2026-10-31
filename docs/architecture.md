# Architecture

This is the **target architecture for the final prototype**. The choice of LiveKit
and PostgreSQL is being recorded in the [decision records](adr/index.md).

## Overview

The host speaks once; every listener hears them in their chosen language.
The backend holds **one Gemini session per target language** and publishes one
audio track per language to LiveKit, which forwards each listener only the
language they picked. Cost grows with the number of languages, not listeners.

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 90, "rankSpacing": 70}}}%%
flowchart TB
  Host["Host app (React)"]

  subgraph Platform["Platform (Docker Compose)"]
    Backend["Backend (Node / Fastify)<br/>1 Gemini session per language"]
    DB[("PostgreSQL")]
    SFU["LiveKit<br/>SFU: selective forwarding unit"]
  end

  Gemini["Gemini Live Translate API"]
  Listener["Listener apps (React)"]

  Host <-- "1. mic audio / captions back (WebSocket)" --> Backend
  Backend <-- "2. audio / 3. translation" --> Gemini
  Backend <-- "session data" --> DB
  Backend -- "4. 1 audio track per language" --> SFU
  SFU -- "5. chosen language: audio + captions (WebRTC)" --> Listener
```

## Step by step

```mermaid
sequenceDiagram
  participant H as Host app
  participant B as Backend
  participant D as PostgreSQL
  participant G as Gemini Live Translate
  participant K as LiveKit (SFU)
  participant L as Listener apps
  H->>B: create session
  B->>D: save session details
  H->>B: 1. mic audio, 100 ms chunks (WebSocket)
  B->>G: 2. host audio (1 session per language)
  G-->>B: 3. translated audio + captions
  B-->>H: captions (WebSocket)
  B->>K: 4. publish 1 audio track per language
  K-->>L: 5. forward the listener's language (WebRTC)
```

An **SFU (selective forwarding unit)** receives each audio track once and forwards
it to every listener who subscribed to it, without decoding or mixing. Listeners
connect to it over **WebRTC**, which is built for real-time media.

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
