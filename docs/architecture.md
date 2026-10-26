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
