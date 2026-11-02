# 0013. LiveKit client connection in the PWA

- **Status:** Proposed
- **Date:** 2026-10-29
- **Deciders:** Marek Culak
- **Ticket:** YGP-46

## Context

LiveKit is already chosen and its deployment is not part of this work. The PWA needs a way to connect to a LiveKit session: the host publishes the microphone and the listener subscribes to the track for their language. The PoC used WebSockets with raw PCM. The PWA is where this connection is developed.

## Options considered

1. **@livekit/components-react**: React hooks and components on top of livekit-client.
    - Pros: least code; idiomatic React; handles track attachment and audio rendering.
    - Cons: less control; one more abstraction over the SDK.
2. **livekit-client SDK directly**.
    - Pros: full control over room, tracks, reconnection and devices.
    - Cons: we write the React glue and track handling ourselves.
3. **Direct WebRTC without the SDK**.
    - Pros: no LiveKit client dependency.
    - Cons: LiveKit's clients join through its own signalling protocol, so we would re-implement signalling, reconnection and subscription management; WHIP exists for ingest only.

## Decision

We will use @livekit/components-react by default and drop to livekit-client where the components do not expose what we need (for example microphone switching or interruption handling). Both run on the same SDK, so there is an escape hatch.

**Why the other options are not the best fit:**

- **livekit-client alone**: it is the escape hatch, but starting there means writing glue the components already provide; we drop to it only where needed.
- **Direct WebRTC**: it would mean re-implementing what the SDK does for little benefit, and it is not an intended way to join a LiveKit room (to be verified).

## Consequences

- Good: fast to build the screens; fits media-element playback (ADR 0011).
- Bad / trade-offs: coupling to LiveKit libraries and server versions; the abstraction may hide mobile-audio control; bundle size.
- Follow-up work: verify against the current LiveKit docs that a bare WebRTC client is not a supported path; check which features components-react exposes (device switching, reconnect events); agree the room and token handoff with the media-plane owner; measure the bundle impact.
