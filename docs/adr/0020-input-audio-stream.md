# 0020. Host audio reaches the translation workers through LiveKit rooms

- **Status:** Proposed
- **Date:** 2026-11-05
- **Deciders:** Marek Culak
- **Ticket:** YGP-43

## Context

The earlier design had the host's browser stream audio directly to a translation container, which then published into LiveKit. With pooled, queue-dispatched, single-use pods (0018) that no longer fits, so the audio path changes. The whole sequence, with everything outside the container kept short:

1. The host creates a session in the PWA. Hono stores the session and one track per target language in Postgres.
2. Hono creates a **source room** for the session and one **output room per language** through LiveKit's room API, all at the start of the session, and enqueues one job per track (0018).
3. An idle worker takes a job and calls Hono's claim endpoint. Hono validates the track and returns LiveKit tokens: subscribe-only for the source room, publish-only for the output room. Workers never hold the LiveKit API secret.
4. **Inside the container:** the worker joins the source room and subscribes to the host's audio, decodes and prepares it, sends it to Gemini over its own connection, receives the translated audio, encodes it and publishes it into its output room.
5. Once it has joined both rooms and opened its Gemini connection, the worker reports the track as live to Hono. Live means ready: it does not wait for any audio. The host UI shows each track as live or not live, and the session becomes live once all tracks are live or a threshold is met. The host starts sending audio after this green light.
6. Listeners enter the session code at Hono, pick a language, receive a subscribe-only token for that output room, and LiveKit fans the audio out to them.
7. When the host stops the session, or has been gone for 60 s, Hono marks the session ending and deletes the source room. Each worker sees it close, stops its Gemini connection, acknowledges its job in the queue and exits (0018). Hono then deletes the output rooms, which disconnects the listeners, and marks the session ended.

The host publishes upstream once. Each worker, being one track, is simply another subscriber of the host's audio.

## Options considered

1. **Host publishes to a LiveKit source room; workers subscribe**
    - Pros: the host uploads once and the SFU duplicates the stream to every worker; no session-affine routing, so any idle worker can serve any track; workers are interchangeable and fit queue dispatch; no ingress path of our own in the container; reuses LiveKit, which the host already connects to.
    - Cons: one extra hop (tens of milliseconds, small against the 4 s audio budget); LiveKit becomes a dependency of the translation path; each pod decodes the host audio separately, which is acceptable at one track per pod.
2. **Host streams directly to the container over WebSocket or WebRTC** (the earlier design)
    - Pros: no extra hop; fewer moving parts for a single container.
    - Cons: a specific pod must be chosen before the host connects, and the browser must be routed to it; with one pod per language the host would upload once per pod or an extra fan-out layer would be needed; the container needs its own ingress and, for WebRTC, its own ICE/TURN handling; if a pod dies the host's browser has to reconnect to a new one; incompatible with pooled, single-use pods.

Rejected: 2. It is rejected because direct ingest ties the host to one specific pod, which conflicts with a warm pool where pods are interchangeable and replaced.

## Decision

The host publishes to a **LiveKit source room**, and the translation workers join it as subscribers.

- One source room per session, and one output room per language (shard 0 for now), all created by Hono at the start of the session. Names are deterministic and include the session and language, with a shard slot reserved so a heavily used language can later be split across rooms and nodes.
- **Hono's claim endpoint issues the worker tokens**, scoped to subscribe-only for the source room and publish-only for the output room.
- The host UI shows each track as live or not live, where live means ready (rooms joined and Gemini connection open, no audio needed yet). Each worker opens its Gemini connection when it claims its job, on the assumption that the host sends audio straight after the green light.
- Listeners join only the output room of their language. Changing language means joining a different room.

## Consequences

### Good

- Workers are interchangeable, so scaling and replacing pods needs no routing.
- The host uploads one stream regardless of the number of languages.
- Listener fan-out is handled entirely by LiveKit.
- A room lives on one node, so per-language output rooms spread listeners across nodes once LiveKit is multi-node.
- The host sees per-track status.

### Bad / trade-offs

- An extra hop and a LiveKit dependency in the translation path.
- Room management (creation, deletion, orphans) is now Hono's responsibility.
- Claims go through Hono, which sits on the session start path.
- Each pod decodes the host audio itself.
- Switching language involves a short gap while joining another room.

### Follow-up work

- Confirm that deleting the rooms is the release signal, and define the backstop for a worker that misses it (see the liveness follow-up in 0018).
- Revisit if hosts do not send audio straight after the green light: workers claimed at session creation then hold idle Gemini connections, and Gemini Live connections have lifetime limits (check the current limits). Open: the threshold at which a session counts as live, and where the 60 s host-gone grace runs (a webhook reports the departure at once, so Hono or the janitor has to apply the wait; verify).
- Confirm room naming, token lifetimes and permissions, and whether workers can join as hidden participants.
- Verify LiveKit behaviour for duplicate participant identity (fencing, see 0018) and for disabling automatic room creation.
- Janitor: a cron every minute compares LiveKit's rooms with the active sessions, deleting rooms that have no live session and ending sessions whose rooms vanished.
- Load-test an output room with 5,000 subscribers, and check the per-node room limit against LiveKit's current documentation.
- Define the claim endpoint in the OpenAPI contract (0019).
