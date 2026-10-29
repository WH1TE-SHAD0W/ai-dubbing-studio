# 0010. React + Vite as a PWA

- **Status:** Proposed
- **Date:** 2026-10-29
- **Deciders:** Marek Culak
- **Ticket:** YGP-41

## Context

Listeners join on their own phone or laptop without an account, usually from a QR code or a code on a slide. Hosts use a browser. The proposal specifies a PWA and the PoC is already a mobile-first React PWA. We are a team of two with a lean MVP.

## Options considered

1. **React + Vite with vite-plugin-pwa**: Vite builds and serves the app; the plugin generates the web app manifest and a Workbox service worker.
    - Pros: one codebase; no store or install step (join by code or QR); installable from the home screen; continuity with the PoC.
    - Cons: limited OS integration; background and locked-screen audio is less certain than native.
2. **Native apps (Swift/Kotlin)**.
    - Pros: best OS integration and background audio.
    - Cons: two codebases; store review and distribution; installing an app is too much friction for a conference listener.
3. **Cross-platform native (React Native, Flutter)**.
    - Pros: one codebase for both phone platforms; more OS access than a PWA.
    - Cons: still store distribution and install friction; a build chain separate from the web app.
4. **Capacitor wrapper around the web app**.
    - Pros: reuses the web code; adds native background audio.
    - Cons: store distribution and a native build chain.
5. **Plain web app without PWA features**.
    - Pros: least to build.
    - Cons: no home-screen install and no app-shell caching.

## Decision

We will build a React + Vite PWA with a minimal scope: web app manifest and app-shell caching through vite-plugin-pwa. No push notifications and no offline mode, because live audio needs the network anyway. This is the low-friction path: join by code or QR, nothing to install from a store.

**Why the other options are not the best fit:**

- **Native and cross-platform native**: listeners join from a QR code or a code on a slide, so an install from a store is the wrong first step, and two builds are too much for two developers.
- **Capacitor wrapper**: worth it only if background audio fails (ADR 0011); until then it adds a build chain and store distribution for a risk we have not confirmed.
- **Plain web app**: it drops installability and caching for very little saving, since the plugin adds both with a small configuration.

## Consequences

- Good: one codebase; no store; instant join; continuity with the PoC.
- Bad / trade-offs: weaker OS integration than native; background and locked-screen audio is less certain (ADR 0011).
- Follow-up work: service-worker update behaviour during a live session; caching rules that exclude audio and API calls; manifest and icons.
