# Architecture

How the parts of AI Dubbing Studio fit together. The reasons for each choice are
in the [decision records](adr/index.md); a closer look at each part, with the
detailed flows, is in [Architecture layers](architecture-layers.md).

## Overview

The host speaks once; every listener hears them in their chosen language.

- The **Hono API** handles host logins and sessions, stores them in
  PostgreSQL, and serves the app. When a session goes live, it hands each
  target language to a translator worker.
- The **translator workers** are a pool of small Go processes. Each one
  translates **one target language of one session** with Gemini Live
  Translate, then exits, and a fresh one takes its place. Idle workers wait for
  work on a **Redis Stream**.
- **PostgreSQL** records which worker owns each language's translation.
  **Redis** only delivers the jobs.
- **LiveKit** will carry the audio: the host publishes once to a source room,
  each worker publishes its language to that language's room, and each
  listener joins only the room of the language they picked.

Cost grows with the number of languages, not listeners.

## What is built

| Part | Status |
|---|---|
| The app (React PWA): register, log in, Studio, join, listener pages | Built. Listening needs LiveKit. |
| API: host logins, sessions (create, go live, end), joining by code | Built |
| API: translation tracks, the Redis job stream, the workers' internal API, the sweeper that recovers tracks | Built |
| Translator workers (Go) with Gemini Live Translate | Built. Until LiveKit is connected, a worker reads the host's audio from a WAV file and writes the translation to another one. |
| LiveKit server | Runs in Docker Compose (`config/livekit.yaml`), but nothing uses it yet |
| LiveKit in the app, the API and the workers: the host's audio in, translated audio out, listener tokens | Not built |
| Captions | Not built |

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 70, "rankSpacing": 70}}}%%
flowchart TB
  Host["Host (PWA)"]
  Listener["Listeners (PWA)"]

  subgraph Platform["Our platform"]
    API["Hono API<br/>logins, sessions, serves the app"]
    DB[("PostgreSQL<br/>accounts, sessions,<br/>who translates each language")]
    Q[("Redis Stream<br/>translate:jobs")]
    W["Translator workers (Go)<br/>1 worker = 1 language of 1 session"]
    SFU["LiveKit (not used yet)<br/>source room, 1 room per language"]
  end

  Gemini["Gemini Live Translate API"]

  Host -- "log in, create, go live, end" --> API
  Listener -- "join by code" --> API
  API <-- "accounts, sessions, tracks" --> DB
  API -- "1 job per language" --> Q
  Q -- "each job to one idle worker" --> W
  W -- "claim, heartbeat, status" --> API
  W <-- "host audio / translated audio" --> Gemini
  Host -. "mic audio" .-> SFU
  SFU -. "host audio" .-> W
  W -. "translated audio" .-> SFU
  SFU -. "chosen language (WebRTC)" .-> Listener
```

Dotted lines are the LiveKit parts that aren't built yet: the LiveKit server
runs in Docker Compose, but nothing connects to it so far.

## Step by step

A session from creation to its end. The [layers page](architecture-layers.md)
shows each part of it in more detail, and what happens when a worker fails.

```mermaid
sequenceDiagram
  participant H as Host (PWA)
  participant A as Hono API
  participant D as PostgreSQL
  participant R as Redis Stream
  participant W as Translator worker
  participant G as Gemini Live Translate
  H->>A: create session (title, languages)
  A->>D: save it as a draft, with its languages
  H->>A: go live
  A->>D: session live, 1 translation track per language
  A->>R: 1 job per language
  R-->>W: each job to one idle worker
  W->>A: claim the track
  A->>D: owner = this worker, lease 15 s
  W->>G: open a stream for the target language
  W->>A: status live
  loop every 5 s
    W->>A: heartbeat (renews the lease)
  end
  W->>G: host audio
  G-->>W: translated audio
  Note over W: Today the host audio comes from a WAV file and the<br/>translation goes to a WAV file. With LiveKit, from the<br/>source room and to the language's room.
  H->>A: end session
  A->>D: session and its tracks ended
  W->>A: next heartbeat
  A-->>W: 409 ended
  Note over W: stops, exits, a fresh worker takes its place
```

Measured in Docker Compose with the real Gemini API: each language was claimed
28 ms after **Go live** and live within half a second, translated speech came
about 3 seconds after the first words, and after **End session** every worker
stopped at its next heartbeat (within 5 seconds).

An **SFU (selective forwarding unit)** such as LiveKit receives each audio track
once and forwards it to every listener who subscribed to it, without decoding or
mixing. Listeners connect to it over **WebRTC**, which is built for real-time
media.

### A listener joins

```mermaid
sequenceDiagram
  participant L as Listener (PWA)
  participant A as Hono API
  participant D as PostgreSQL
  L->>A: open the link or enter the join code
  A->>D: find the session by its code (not ended)
  D-->>A: title, host, languages
  A-->>L: session details and languages
  L->>A: choose a language, ask for a LiveKit token
  A-->>L: not available yet (LiveKit isn't connected)
  Note over L: With LiveKit, the token lets the listener join<br/>only that language's room
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

The details are in [ADR-0003](adr/0003-host-authentication.md).

## Why it's built this way

| Part | Decision |
|---|---|
| LiveKit for listener audio | [ADR-0001](adr/0001-audio-fan-out.md) |
| PostgreSQL | [ADR-0002](adr/0002-session-and-account-storage.md) |
| Host logins | [ADR-0003](adr/0003-host-authentication.md) |
| Hono for the API | [ADR-0007](adr/0007-backend-framework.md) |
| Translation runs apart from the API | [ADR-0008](adr/0008-separated-container.md) |
| The translation provider is chosen per session | [ADR-0009](adr/0009-translation-engine-communication.md) |
| One React PWA | [ADR-0010](adr/0010-mobile-native.md) |
| Audio on phones | [ADR-0011](adr/0011-audio-handling.md) |
| Hono serves the app | [ADR-0012](adr/0012-serving-pwa-bundle.md) |
| LiveKit client in the app | [ADR-0013](adr/0013-sfu-client.md) |
| The app's pages | [ADR-0014](adr/0014-pages.md) |
| Better Auth for host logins | [ADR-0015](adr/0015-auth-library.md) |
| Schemas and validation | [ADR-0016](adr/0016-schema-validator.md) |
| Jobs through a Redis Stream to single-use workers, owners in Postgres | [ADR-0018](adr/0018-autoscaling-architecture-of-translation-container.md) |
| The translator worker in Go, with an OpenAPI contract to the API | [ADR-0019](adr/0019-translation-worker-runtime.md) |
| Host audio through a LiveKit source room, one room per language | [ADR-0020](adr/0020-input-audio-stream.md) |

## Data model

PostgreSQL stores host accounts, logins, sessions, their target languages, and
who translates each language. The reasons are in
[ADR-0002](adr/0002-session-and-account-storage.md) (storage),
[ADR-0003](adr/0003-host-authentication.md) (host logins) and
[ADR-0018](adr/0018-autoscaling-architecture-of-translation-container.md)
(translation tracks). Host accounts and logins use the tables Better Auth creates
(`user`, `account`, and its `session` table, renamed to `logins`); only their
main fields are shown. Better Auth also creates `verification` and, because rate
limits are kept in the database, `rateLimit`; neither is drawn here.

```mermaid
erDiagram
  user ||--|| account : "signs in with"
  user ||--o{ logins : "is logged in by"
  user ||--o{ sessions : runs
  sessions ||--|{ session_languages : "is translated into"
  session_languages ||--o| translation_tracks : "is translated by"

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
    uuid id PK "used in URLs"
    text host_id FK
    text join_code "unique while not ended"
    text title
    text source_lang
    text provider "gemini"
    text status "draft, live or ended"
    timestamptz created_at
    timestamptz started_at "null until live"
    timestamptz ended_at "null until ended"
    text end_reason
  }
  session_languages {
    uuid session_id PK, FK
    text lang PK
    int position "the order the host picked"
    int peak_listeners
  }
  translation_tracks {
    uuid id PK "the trackId in jobs"
    uuid session_id FK
    text lang FK
    text status "pending, claimed, live, ended, failed"
    text worker_id "the worker that owns it"
    timestamptz lease_until "renewed by heartbeats"
    int attempts "workers that failed or vanished"
    timestamptz enqueued_at "when its job was sent"
    text reason "why it last changed hands or stopped"
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
- **session_languages:** each target language of a session, in the order the
  host picked them, with its peak listener count to show where the Gemini cost
  goes. LiveKit rooms aren't stored: their names are made from the session and
  the language ([ADR-0020](adr/0020-input-audio-stream.md)).
- **translation_tracks:** one per language once the session goes live: its
  status, the worker that owns it and that worker's lease. A worker renews the
  lease every 5 seconds; when a lease runs out, the track goes to another
  worker. After 3 workers failed or vanished on it, it is `failed`.
- Deleting a session deletes its languages and tracks; deleting a host deletes
  their logins and sessions.
- Our tables are created by numbered SQL files in `apps/api/migrations`, each
  applied once and recorded in `schema_migrations`.
- Redis holds only the job messages, never the owner of a track.
- **Not stored in the database:** audio, captions or transcripts, listener
  identities, and live state such as connections. Until LiveKit is connected,
  the workers write the translated audio to WAV files, for development.
