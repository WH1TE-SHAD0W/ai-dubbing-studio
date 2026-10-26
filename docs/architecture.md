# Architecture

How live audio flows from the host to listeners in the current proof of concept.

## Overview

The host speaks once; every listener hears them in their chosen language.
All browser traffic goes through nginx at `/api`. The backend holds
**one Gemini session per target language**, shared by every listener of that language,
so cost grows with the number of languages, not listeners.

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 90, "rankSpacing": 70}}}%%
flowchart TB
  Host["Host app (React)"]

  subgraph Platform["Platform: Docker Compose, all traffic via nginx /api"]
    Backend["Backend (Node / Fastify)<br/>1 Gemini session per language"]
  end

  Gemini["Gemini Live Translate API"]
  Listener["Listener apps (React)"]

  Host -- "1. mic audio" --> Backend
  Backend <-- "2. audio / 3. translation" --> Gemini
  Backend -- "4. fan-out per language" --> Listener
```

## Step by step

```mermaid
sequenceDiagram
  participant H as Host app
  participant B as Backend
  participant G as Gemini Live Translate
  participant L as Listener apps
  H->>B: 1. mic audio, 100 ms chunks (WebSocket)
  B->>G: 2. host audio (1 session per language)
  G-->>B: 3. translated audio + captions
  B-->>L: 4. fan-out to every listener of that language (WebSocket)
```

**Fan-out** (step 4) is where the backend copies each language's audio to every
listener of that language. It is the part a selective forwarding unit (SFU) such
as LiveKit would replace; see the [decision records](adr/index.md).
