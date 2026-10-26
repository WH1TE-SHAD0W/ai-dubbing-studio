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

## Measurements

### Option 1: WebSocket fan-out (2026-10-26)

**Setup:** one laptop (Intel i7-1355U, 14 GB RAM), the app running in Docker Compose,
one live session translating English to Slovak. The host is Chrome with a fake microphone
that loops a speech WAV. Fake listeners are opened by
[`backend/scripts/bench-fanout-ws.ts`](https://github.com/WH1TE-SHAD0W/ai-dubbing-studio/blob/main/backend/scripts/bench-fanout-ws.ts)
(one per second, measured for 30 s once all have joined), all on the same session.

| Listeners | Bandwidth per listener (kbit/s) | Gap between chunks, median / p99 / max (ms) | Closed |
|---|---|---|---|
| 1 | 387 | 249 / 348 / 405 | 0 |
| 10 | 384 | 250 / 352 / 365 | 0 |
| 50 | 384 | 250 / 357 / 379 | 0 |

With 50 listeners the backend container used **2.1% CPU and 33 MiB of memory**
(`docker stats`), while sending about **19 Mbit/s** (50 × 384 kbit/s) for one language.

**What this shows:**

- Bandwidth is the raw PCM figure of **384 kbit/s per listener**, as expected.
- Going from 1 to 50 listeners **did not change** the gaps between chunks. The ~250 ms
  rhythm and the ~350 ms worst case come from how Gemini sends audio, not from the fan-out.
- CPU and memory are not the limit at this scale. **Bandwidth is:** it grows by 384 kbit/s
  for every listener of every language.

**Limitations:** everything ran on `localhost`, so there was no real network, no packet loss
and almost no delivery delay. These results cannot show how TCP behaves on a weak mobile
connection; that is assessed from documentation instead.

### Option 3: LiveKit (2026-10-26)

**Setup:** same laptop and same live Slovak session. LiveKit server v1.13.10 ran in its own
Docker container in dev mode. A bridge,
[`benchmarks/fanout-livekit/bridge.ts`](https://github.com/WH1TE-SHAD0W/ai-dubbing-studio/blob/main/benchmarks/fanout-livekit/bridge.ts),
joined the session as an ordinary listener and published the translated audio into a LiveKit
room as one track, so LiveKit received exactly the same audio as option 1. The listeners were
LiveKit's own load tester (`lk load-test` from `livekit-cli` v2.19.0), joining one per second
and measuring for 30 s.

| Listeners | Bitrate per listener (kbit/s) | Packet loss | Errors |
|---|---|---|---|
| 1 | 44.6 | 0% | 0 |
| 10 | 43.7 – 44.3 | 0% | 0 |
| 50 | 42.6 – 44.8 | 0% | 0 |

With 50 listeners the LiveKit container used **3.8% CPU and 129 MiB of memory** (`docker stats`).

**What this shows:**

- Each listener needs about **44 kbit/s**, compared with 384 kbit/s for option 1:
  roughly **8.7× less bandwidth**. For 50 listeners of one language that is about
  **2.2 Mbit/s instead of 19 Mbit/s**.
- Adding listeners did not change the bitrate per listener or cause packet loss.
- LiveKit uses a little more CPU and about 4× more memory than the backend did for option 1,
  but both are small at this scale.

**Notes on comparing the two:**

- The tools count bytes slightly differently: our script counted only audio bytes, while
  LiveKit's figure may include packet headers. If so, LiveKit's real saving is slightly larger.
- The "gap between chunks" from option 1 can't be compared: LiveKit re-paces audio into
  even 20 ms packets (about 48 per second were received), so packet loss is reported instead.
- The load tester's "Total" average is lower than the per-listener rows, most likely because
  it averages over the time when later listeners were still joining. The per-listener rows
  are used here.
- The bridge did the Opus encoding, and its CPU was not measured. In the target architecture
  that work moves to the backend.
- The same `localhost` limitation applies: no real network and no packet loss.

## Decision

*To be written once options 1 and 3 have been measured.*

## Consequences

*To be written with the decision.*
