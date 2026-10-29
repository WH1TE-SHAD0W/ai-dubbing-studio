# 0008. Separate the dubbing container from Hono

- **Status:** Proposed
- **Date:** 2026-10-29
- **Deciders:** Marek Culak
- **Ticket:** YGP-42

## Context

The PoC is one Node backend that holds auth, sessions, host audio ingress, the Gemini connections and listener fan-out, with state in memory and a single replica (PoC README). In production Hono must scale fast when many people connect at once, while the audio side holds long-lived streams and talks to external translation APIs. LiveKit and the database are outside this ADR.

## Options considered

1. **Two containers**: Hono (auth and listener-to-session connector) and a dubbing container (translation-API calls, audio I/O, engine abstraction).
    - Pros: scale independently; redeploying the API does not cut live translation; the engine can change without touching the API.
    - Cons: a contract and a network hop to maintain; two deployables; Hono must handle the container being unavailable.
2. **One backend as in the PoC**: everything in one Node process.
    - Pros: simplest to build and run; no contract between parts.
    - Cons: join bursts and long audio streams compete in one process; a deploy drops live sessions; in-memory state on a single replica cannot scale out.
3. **Engine as a third service behind the dubbing container**.
    - Pros: the engine could scale and change fully on its own.
    - Cons: an extra hop in the audio path and one more deployable, with no benefit yet.

## Decision

We will run Hono and the dubbing container as separate containers, because their load patterns and failure impact differ. The dubbing container owns the engine abstraction, so the provider is chosen per session by the request Hono sends (ADR 0009).

**Why the other options are not the best fit:**

- **One backend**: it is the PoC's shape and fine for a demo, but at conference start the join burst and the audio streams compete for the same process, and any deploy cuts live sessions.
- **Third engine service**: worth it only when the engine must scale or change on its own schedule; today it adds a hop in the audio path and one more thing to run for no gain.

## Consequences

- Good: Hono stays light and quick to scale; the engine can change without touching the API.
- Bad / trade-offs: two deployables; Hono must handle the dubbing container being unavailable.
- Follow-up work: open question: call style between Hono and the container (to be revisited); behaviour when the container is down; whether a separate engine service is ever needed.
