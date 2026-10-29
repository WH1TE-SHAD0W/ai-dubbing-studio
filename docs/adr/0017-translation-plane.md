# 0017. Dubbing container framework and runtime

* **Status:** Proposed
* **Date:** 2026-10-29
* **Deciders:** Marek Culak
* **Ticket:** YGP-47

## Context

The translation plane requires a dedicated, stateless container runtime to handle audio processing, maintain live connection states, and serve as the bridge between the React host, Gemini, and LiveKit. The container exposes a REST control interface (`/sessions`, `/health`, `/ready`) and a WebSocket ingest endpoint for host audio streaming. The primary architectural requirement is high modularity (using a ports-and-adapters pattern) and shared type safety with the Hono-based control plane in a pnpm monorepo. The container runtime must manage asynchronous audio pipelines with minimal CPU overhead, as heavy AI dubbing computation is offloaded to the Gemini API while media distribution is delegated to an in-cluster LiveKit SFU. Endpoints can be added, but this is the underlying architecture.

## Options considered

1. **Hono on Node.js runtime (`@hono/node-server` and `@hono/node-ws`)**.
* **Pros:** Identical framework and developer experience across control plane and dubbing container; native support for real-time Node.js C++ bindings required by the LiveKit Node SDK; robust WebSocket upgrade handling; seamless schema and contract sharing via monorepo packages; lightweight footprint without full-stack framework overhead.
* **Cons:** Single-threaded event loop requires disciplined async I/O handling and strict per-pod session capping to avoid event-loop blocking during audio frame processing.


2. **Express or Fastify on Node.js**.
* **Pros:** Battle-tested Node.js web frameworks with mature ecosystem and native C++ binding compatibility for LiveKit.
* **Cons:** Introduces unnecessary framework fragmentation against the existing Hono control plane; higher boilerplate for WebSocket integration; fastify/express routing syntax differs from Hono's unified Zod-based contract schema integration.


3. **Hono on Bun or Deno runtime**.
* **Pros:** Native performance gains for HTTP routing, lower memory startup overhead, and built-in TypeScript execution without compile steps.
* **Cons:** LiveKit’s real-time Node SDK relies on native C++ bindings (`node-gyp`/glibc), which regularly encounter compatibility edge cases or crashes under Bun or Deno runtime translation layers.


4. **Python (FastAPI) or Go microservice**.
* **Pros:** Strong concurrency models (Go goroutines, Python async worker pools) and native WebRTC/audio library support.
* **Cons:** Breaks TypeScript end-to-end type safety and contract sharing with the control plane and React PWA; increases team cognitive load and build pipeline complexity.



## Decision

We will use option 1: **Hono running on Node.js LTS**.

**Why the other options are not the best fit:**

* **Express / Fastify**: Adds framework duplication and unnecessary context-switching across the monorepo when Hono already satisfies all routing, validation, and middleware requirements.
* **Bun / Deno**: High risk of runtime crashes or build failures with LiveKit’s C++ native audio bindings. Node.js LTS provides the necessary stability for real-time native integrations.
* **Python / Go**: Unnecessary language boundary for the MVP that prevents sharing Zod schemas directly across the control plane and media container. Little concurrency benefit.

## Consequences

* **Good:** Monorepo harmony across apps and packages; shared Zod validation schemas (`packages/contracts`); full compatibility with LiveKit C++ native binaries; lightweight CPU-only pods.
* **Bad / trade-offs:** Node.js event-loop limits mean pod capacity must be strictly bounded based on CPU/resampling load testing; graceful termination hooks (`preStop` / `terminationGracePeriodSeconds`) are mandatory during rolling deployments to prevent immediate dropping of active sessions.
* **Follow-up work:** Load-test audio fan-out and resampling on Node.js to determine max concurrent session cap ($N$) per pod for Kubernetes readiness probes; create `apps/dubbing-container` in pnpm monorepo; verify `@hono/node-ws` compatibility with the host ingest protocol.