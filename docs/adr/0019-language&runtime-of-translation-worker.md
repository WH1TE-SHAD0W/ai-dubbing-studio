## 0019. Go as the language and runtime of the translation worker pod

- **Status:** Proposed
- **Date:** 2026-11-05
- **Deciders:** Marek Culak
- **Ticket:** YGP-47

### Context

The translation container was planned as Node.js with Hono, like the control plane. Two things have changed.

First, the container has **no inbound API**. It exposes only health and metrics endpoints, takes its work from the job queue (0018), and calls Hono for claims and state (0020). Its code is the Gemini adapter SDK and the LiveKit module, so it needs no web framework.

Second, the pool design multiplies fixed costs. With one track per pod, every pod carries its own runtime, and idle warm pods are held in reserve. Pods are single-use, so they start often and image pull time counts toward the roughly 30 s start. As a rough, unmeasured estimate, an idle Node pod with the SDKs loaded uses 100–150 MB and a Go pod 15–40 MB. For 100 pods that is about 10–15 GB against about 1.5–4 GB. The decision is driven by **reducing runtime RAM**.

The Hono-to-worker contract (the job payload and Hono's internal claim endpoint) is currently shared as Zod types. A second language means it needs a language-neutral definition.

### Options considered

1. **Node.js with Hono** (the previous decision)
    - Pros: same language and toolchain as the control plane; shared Zod types; quickest route to a working prototype.
    - Cons: Hono is a framework for an API the container does not have; highest per-pod memory and the largest image; single-threaded event loop can add audio jitter under load.
2. **Node.js without a framework**
    - Pros: same ecosystem and shared types; drops the unused framework.
    - Cons: the runtime baseline remains, so the decision driver (RAM per pod) is not addressed.
3. **Rust**
    - Pros: lowest memory use and no garbage collector.
    - Cons: steepest learning curve for a team with no prior experience in the candidate languages; slowest to build; Gemini Live client support would need checking.
4. **Go with a web framework (for example Gin, Echo, Chi or Huma)**
    - Pros: familiar request handling and validation helpers.
    - Cons: adds a dependency to serve two endpoints that the standard library covers.
5. **Go with the standard library only**
    - Pros: low per-pod memory; small image and faster start; predictable latency; `net/http` is enough for health and metrics; LiveKit's own server is written in Go, and its Go SDK can act as a participant.
    - Cons: a second language in the monorepo; loses the shared Zod types; no prior Go experience on the team; Opus encoding may need cgo and libopus, which affects the static-binary and image-size benefit.

Rejected: 1, 2, 3 and 4. Options 1 and 2 are rejected because they keep the Node runtime baseline, which is the problem being solved. Option 3 lowers memory further but at a higher learning and delivery cost. Option 4 is rejected because it adds a framework with nothing to serve.

### Decision

The translation worker is written in **Go with no web framework**.

- Dependencies are the Gemini adapter SDK and the LiveKit Go SDK. The standard library serves the health and metrics endpoints.
- The Hono-to-worker contract (job payload and Hono's internal claim endpoint) is defined in an **open API standard (OpenAPI / JSON Schema)**, and types are generated for both sides. Zod stays in the control plane.
- Hono remains the framework for the control plane only.

### Consequences

**Good**

- Lower baseline RAM per pod, which matters most for the warm pool and one-track-per-pod design (to be measured).
- Smaller image and faster pod start.
- Predictable latency without an event loop.
- The language boundary matches the plane boundary: control plane in TypeScript, translation plane in Go.

**Bad / trade-offs**

- Two languages in the monorepo, with separate tooling.
- The shared Zod types are replaced by a schema definition and code generation.
- Nobody on the team has prior Go experience.
- Opus handling may require cgo, which weakens the small static binary.
- Go SDK support for the Gemini Live API and for publishing audio to LiveKit is not yet confirmed.

**Follow-up work**

- Run a spike in both languages with the real SDKs and measure idle memory, memory with one live track, image size, start time and audio glitches.
- Verify Go support for Gemini Live audio streaming and LiveKit audio publishing, including the Opus approach (cgo or an alternative).
- Choose the OpenAPI / JSON Schema tooling and code generation, and how Hono produces or consumes it.
- If the SDK checks fail, supersede this ADR and return to Node.js without Hono.
