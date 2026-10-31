# 0014. PWA pages

- **Status:** Proposed
- **Date:** 2026-10-29
- **Deciders:** Marek Culak
- **Ticket:** YGP-23

This is mostly a sign-off the routing design as how we have it during the PoC. Follow up work introduces work at designing the UX or a sign-off of what we have. Shows the flow as a user stories. This ADR then reflects the actual docs for react build up.

## Context

The proposal describes two primary flows: the host (sign-in, create session, studio control room) and the listener (join, language and audio check, live view). The PoC implements six screens based on initial wireframes. As we transition from PoC to MVP, we need to formalize the client page architecture and routing structure within our React application (`@tanstack/react-router` / React SPA). Hosts require authentication; listeners never do.

## Options considered

1. **Five top-level route pages (Merged Studio flow)**.
    - Pros: Fewer top-level routes; unifies session creation and live session management within a single host route state machine; minimal navigation churn transitioning from PoC to MVP.
    - Cons: `Studio` and `Listener` become heavy multi-state pages requiring clean internal state/component orchestration.
2. **Six separate routes matching wireframes 1:1**.
    - Pros: Single responsibility per route URL; strict 1:1 mapping with raw wireframe frames.
    - Cons: Introduces redundant route transitions (e.g., navigating from `/create` to `/studio/:id`); forces split context management for pre-session and live-session host states.

## Decision

We confirm **Option 1 (Five top-level pages)** as the definitive page architecture for the React client as we continue development from PoC to MVP.

Rather than creating separate URL routes for every wireframe frame, the React application will structure the frontend around five core pages, managing sub-states (such as pre-flight audio checks or session creation steps) as internal view components or modal states.

### Core Page Mapping

| Page | Target User | Purpose / Primary React Components |
|---|---|---|
| **Register** | Host | Account creation (`/register`) |
| **Login** | Host | Authentication with email and password (`/login`) |
| **Join** | Listener | Enter 6-character code or handle incoming URL/QR deep links (`/join`, `/j/:code`) |
| **Studio** | Host | Unified host workspace (`/studio`): session creation form, active control room (listeners, latency, tracks, captions, end session) |
| **Listener** | Listener | Live audio consumption workspace (`/listen/:code`): language selection, audio check/playback, live captions |

**Why Option 2 was not selected:**
Splitting session creation and the live control room into separate top-level React routes adds artificial router transitions without functional benefit. Creation and execution belong to the same host session lifecycle and context. The wireframe layouts remain fully preserved as state views inside these five defined React pages.

## Consequences

- **Good:** Definitive route layout for the MVP React client; simple, clean routing hierarchy; zero friction for listeners (no account setup required).
- **Bad / Trade-offs:** The `Studio` and `Listener` React page components hold significant state complexity; state management (Zustand / React Context / LiveKit SDK hooks) must be cleanly decoupled into sub-components.
- **Follow-up work:**
    - Standardize where the language/audio check state resides within the `Listener` page pipeline.
    - Determine if forgot-password flows belong in MVP scope or post-MVP.
    - Integrate host voice enrollment / consent workflows into the `Studio` creation phase.
    - Define exact UX state for listeners attempting to join via code/link before the host has transitioned the session to live.
