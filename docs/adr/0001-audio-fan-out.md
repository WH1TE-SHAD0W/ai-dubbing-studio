# 0001. How translated audio reaches listeners (fan-out)

- **Status:** Proposed
- **Date:** 2026-10-26
- **Deciders:** Jamie
- **Ticket:** YGP-6

## Context

The host speaks once, and every listener hears them in their chosen language.
The backend holds one Gemini Live Translate session per target language. Each
session returns one stream of translated audio (PCM16, mono, 24 kHz) plus captions.
That one stream has to be copied to every listener of that language: this is the
**fan-out**.

How the proof of concept does it today:

- The backend sends each listener the raw PCM over its own **WebSocket**, which
  runs over TCP. Raw 24 kHz 16-bit audio is **384 kbit/s per listener**, so
  50 listeners of one language need about 19 Mbit/s from the backend.
- On a lost packet, TCP holds back everything behind it until the packet is re-sent
  (head-of-line blocking). Listener playback compensates with a ~120 ms buffer and
  speeds up when it falls behind.
- It works: on 2026-10-26, manual tests passed for several listeners, refreshing,
  switching language, the host leaving, and ending the session.

Constraints:

- The app is mobile-first: listeners are often on phones and weak Wi-Fi.
- It is self-hosted with Docker Compose, and audio must not be stored (privacy).
- A small student team, with a fixed deadline for the final prototype.

### Decision criteria (in order of importance)

1. **Latency:** from translated audio leaving the backend to the listener hearing it. Pass mark: ≤ 1.5 s end to end (the app's "Good" level).
2. **Effort to build:** can the team build it well before the deadline?
3. **Bandwidth per listener** (kbit/s).
4. **Listeners per server** before quality drops.
5. **Behaviour under packet loss.**
6. **Mobile and browser support** (iOS Safari, Android Chrome).

Options 1 and 3 are **measured**; options 2, 4 and 6 are assessed **on paper**
(documentation and features).

## Options considered

1. **Keep the WebSocket fan-out** (the current proof of concept). *Measured.*
    - Pros: already built and tested, no extra services, easy to debug.
    - Cons: uncompressed audio (high bandwidth), TCP head-of-line blocking on lossy
      networks, and the backend does all the copying.

2. **WebSocket fan-out with Opus compression.** *Paper.*
    - Pros: same simple design, but much less bandwidth per listener.
    - Cons: still TCP. Needs an Opus encoder in the backend and Opus decoding in
      every browser (to check: browser support for this on iOS Safari).

3. **LiveKit, self-hosted SFU.** *Measured.*
    - Pros: WebRTC over UDP with Opus; built for real-time media at scale; open source
      and runs in Docker; browser and Node SDKs, so the team doesn't build WebRTC itself.
    - Cons: one more service to run; needs UDP ports, and possibly a TURN server for
      restrictive networks; a new SDK for the team to learn.

4. **mediasoup** (SFU library for Node). *Paper.*
    - Pros: very flexible, and runs inside a Node backend.
    - Cons: low-level: the team must build signalling, rooms and reconnection itself,
      which is a lot of effort for the deadline.

5. **Janus** (WebRTC server). Considered, not pursued: it overlaps with mediasoup and
   LiveKit, and wouldn't change the decision.

6. **Hosted SFU service** (e.g. LiveKit Cloud). *Paper.*
    - Pros: no media servers to run, and it scales for us.
    - Cons: costs money as usage grows (to check: pricing), and listener audio leaves our
      own platform, which has privacy implications.

## Decision

*To be written once options 1 and 3 have been measured.*

## Consequences

*To be written with the decision.*
