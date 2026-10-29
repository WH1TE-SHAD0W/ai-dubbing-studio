# 0011. Mobile audio handling

- **Status:** Proposed
- **Date:** 2026-10-29
- **Deciders:** Marek Culak
- **Ticket:** YGP-44

## Context

The top requirement is playback while the phone is locked or the screen is off. Bluetooth must work for audio output (listener) and input (host microphone). Target platforms: laptop browsers and Chromium-based home-screen PWAs. The reference is the behaviour of the YouTube Music PWA. The PoC holds a screen Wake Lock, plays PCM through Web Audio with a jitter buffer, and has a microphone picker with gap-free switching; its README notes that a Bluetooth headset can change the phone's audio route and that choosing the listener's output device is not built. Microphone, Wake Lock and service worker need HTTPS.

## Options considered

1. **Media-element playback of the LiveKit audio track plus the Media Session API**; microphone through getUserMedia with a device picker; output route left to the OS.
    - Pros: the standard web route to background audio; lock-screen controls and metadata; no native build.
    - Cons: browsers and battery optimisation do not guarantee playback on a locked phone.
2. **Screen Wake Lock, as in the PoC**.
    - Pros: easy to add; stops the screen from locking during a session.
    - Cons: keeps the screen on, so it does not give locked or screen-off listening; drains the battery.
3. **Web Audio scheduling of raw PCM, as in the PoC**.
    - Pros: fine control of buffering and playback speed (the PoC uses a jitter buffer and speeds up when lagging).
    - Cons: tied to the PCM-over-WebSocket path; generally a weaker fit for background playback than a media element (to be verified).
4. **Native shell for background audio**.
    - Pros: more reliable background audio and routing control.
    - Cons: gives up the PWA decision (ADR 0010) and adds store distribution and a native build.

## Decision

We will use option 1 and aim to approach the YouTube Music PWA behaviour. Uninterrupted playback on a locked or screen-off phone is stated as a limitation: it is a target, not a guarantee. Wake Lock stays at most an optional extra.

**Why the other options are not the best fit:**

- **Wake Lock**: the top requirement is playback with the screen locked or off, and Wake Lock does the opposite, so it can only be an optional extra.
- **Web Audio PCM**: it belongs to the PoC's WebSocket audio path, while LiveKit delivers tracks that a media element plays natively; it is also the weaker option for background playback.
- **Native shell**: kept as the fallback; adopting it now would drop the PWA decision before the device spike shows that standard APIs fall short.

## Consequences

- Good: standard APIs, no native build, lock-screen controls.
- Bad / trade-offs: the browser or the phone's battery optimisation may suspend audio; Bluetooth route changes can interrupt playback or the microphone; no listener output-device choice.
- Follow-up work: spike on real devices (locked, screen off, Bluetooth connect and disconnect, headset buttons) with a pass/fail measure against the YouTube Music PWA; open question: iOS is not among the stated targets, confirm; recovery after an interruption (reconnect banner); quality of a Bluetooth headset microphone for the host.
