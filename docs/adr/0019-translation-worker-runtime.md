# 0019. Go as the language and runtime of the translation worker pod

- **Status:** Proposed
- **Date:** 2026-11-05
- **Deciders:** Marek Culak
- **Ticket:** YGP-47

## Context

The translation container was planned as Node.js with Hono, like the control plane ([ADR-0017](0017-translation-plane.md)). Two things have changed, so once accepted this ADR supersedes ADR-0017.

First, the container has **no inbound API**. It exposes only health and metrics endpoints, takes its work from the job queue (0018), and calls Hono for claims and state (0020). Its code is the Gemini adapter SDK and the LiveKit module, so it needs no web framework.

Second, the pool design multiplies fixed costs. With one track per pod, every pod carries its own runtime, and idle warm pods are held in reserve. Pods are single-use, so they start often and image pull time counts toward the roughly 30 s start. A spike with the real SDKs (see [Measurements](#measurements)) found that a Node pod uses about **2× the memory of a Go pod while idle** (37 MiB against 19 MiB) and **2.7× while serving a live track** (62 MiB against 23 MiB). For 100 live tracks that is about 6.2 GiB against 2.3 GiB. The decision is driven by **reducing runtime RAM**.

The Hono-to-worker contract (the job payload and Hono's internal claim endpoint) is currently shared as Zod types. A second language means it needs a language-neutral definition.

## Options considered

1. **Node.js with Hono** (the previous decision)
    - Pros: same language and toolchain as the control plane; shared Zod types; quickest route to a working prototype.
    - Cons: Hono is a framework for an API the container does not have; highest per-pod memory and the largest image (above the Node figures measured without Hono); single-threaded event loop can add audio jitter under load.
2. **Node.js without a framework**
    - Pros: same ecosystem and shared types; drops the unused framework.
    - Cons: the runtime baseline remains (measured at 2× Go's memory idle and 2.7× with a live track), so the decision driver (RAM per pod) is not addressed.
3. **Rust**
    - Pros: lowest memory use and no garbage collector.
    - Cons: steepest learning curve for a team with no prior experience in the candidate languages; slowest to build; Gemini Live client support would need checking.
4. **Go with a web framework (for example Gin, Echo, Chi or Huma)**
    - Pros: familiar request handling and validation helpers.
    - Cons: adds a dependency to serve two endpoints that the standard library covers.
5. **Go with the standard library only**
    - Pros: low per-pod memory (measured at 23 MiB with a live track); small image and faster start; predictable latency; `net/http` is enough for health and metrics; LiveKit's own server is written in Go, and its Go SDK can act as a participant.
    - Cons: a second language in the monorepo; loses the shared Zod types; no prior Go experience on the team; Opus encoding and resampling need cgo (libopus, libsoxr), so the binary is not static and the image needs a Debian base, though it is still half the size of the Node image.

Rejected: 1, 2, 3 and 4. Options 1 and 2 are rejected because they keep the Node runtime baseline, which is the problem being solved. Option 3 lowers memory further but at a higher learning and delivery cost. Option 4 is rejected because it adds a framework with nothing to serve.

## Measurements

### Node vs Go spike (2026-11-05)

**Setup:**

- **Machine:** one Windows 11 machine, Docker Desktop 29 on WSL2 (x86-64, 16 CPUs, cgroup v2).
- **Workers:** two of them, one per language, doing the same steps as the translator pod with the real SDKs.
    - Go 1.27: `server-sdk-go` 2.19, `google.golang.org/genai` 1.77, `go-redis`.
    - Node 24 without a framework (option 2): `@livekit/rtc-node` 1.2.1, `@google/genai` 2.32, `ioredis`.
- **Idle:** the worker waits for a job on `XREADGROUP`.
- **Live:** the worker serves one track.
    - The host loops a text-to-speech recording into a `livekit-server --dev` room.
    - The worker streams it to the real Gemini Live Translate API and publishes the Slovak translation into the out room.
    - A listener in the out room checks that the translation arrives.
- **Runs:** three runs of 5 minutes per scenario and runtime, plus 15-minute idle runs. The table shows medians over the last 3 minutes.
- **How memory was read:** from outside the container, through the Docker Engine API.

The code, the method and every run are in the repository, in `benchmarks/runtime-test/` (its `README.md` and `results/`).

**Working set** is what Kubernetes counts against a pod's memory limit, and roughly what each extra pod on a node costs. **RSS** also counts the binary and its shared libraries, which pods using the same image share, so it is closer to the cost of the first pod on a node.

| | Go | Node | Node ÷ Go |
|---|---|---|---|
| Idle, working set | 18.9 MiB | 36.8 MiB | 1.9× |
| Idle, RSS | 43.8 MiB | 87.5 MiB | 2.0× |
| One live track, working set | 22.7 MiB | 62.3 MiB | 2.7× |
| One live track, peak working set | 24.6 MiB | 84.1 MiB | 3.4× |
| One live track, RSS | 51.0 MiB | 122.6 MiB | 2.4× |
| One live track, CPU (share of one core) | 7.4 % | 13.9 % | 1.9× |
| Image pull size (`docker save`, gzipped) | 44 MiB | 95 MiB | 2.2× |
| Container start → ready | 0.2 s | 0.6 s | |
| Job received → track live | 0.47 s | 0.58 s | |

**What this shows:**

- **The earlier estimate was too high for Node.** It assumed 100–150 MB for an idle Node pod; the measured figure is 37 MiB working set and 88 MiB RSS. For Go the estimate (15–40 MB) was about right.
- **The gap grows when a pod is busy.** It is about 2× when idle and 2.7× with a live track. rtc-node starts its native Rust/libwebrtc runtime on the first connection and adds about 26 MiB. Go's pion stack adds about 4 MiB.
- **At scale:** 100 live tracks plus 3 warm pods take about 2.3 GiB with Go, against 6.2 GiB with Node. That is about 45 busy Go pods per GiB of node memory, against 16 Node pods.
- **Go's idle memory depends on `GOMAXPROCS`.** It is 19–20 MiB with all 16 CPUs and 13 MiB with `GOMAXPROCS=2`.
- **The Go SDKs did the whole job against the real services:**
    - Gemini Live Translate (`translationConfig`, with session resumption and context compression enabled);
    - LiveKit PCM audio in and out, with auto-subscribe off;
    - leaving when the room is deleted.
- **Audio arrived without dropouts in every run, on both runtimes.**
    - The listener received about 30,100 frames of 10 ms per 5 minutes.
    - The longest gap between frames was 14 ms for Go and 20 ms for Node.
    - Translated speech filled 215–236 s of each 5 minutes.
- **Neither image can use the smallest base.** Go needs cgo, so it can't use `distroless/static`. `@livekit/rtc-node` ships only glibc builds, so Node can't use Alpine.

**Limitations:**

- One machine with Docker, not Kubernetes, and one track at a time with no other pods competing for CPU.
- Tracks of 5 minutes. The pod spec's 2-hour target (RSS growth under 10 MB) was not tested.
- Some of the job path was skipped: there was no Gemini `goAway` and reconnect, no heartbeats, and no `/claim` call. The LiveKit tokens came in the job message instead.
- The Node worker had no Hono, so option 1 would use more than the Node figures here.
- The listener's decoder conceals lost packets. A missing gap therefore shows that delivery never stopped, not that every packet arrived.

## Decision

The translation worker is written in **Go with no web framework**.

- Dependencies are the Gemini adapter SDK and the LiveKit Go SDK. The standard library serves the health and metrics endpoints.
- The Hono-to-worker contract (job payload and Hono's internal claim endpoint) is defined in an **open API standard (OpenAPI / JSON Schema)**, and types are generated for both sides. Zod stays in the control plane.
- Hono remains the framework for the control plane only.

## Consequences

### Good

- **Less RAM per pod:** about 2× less than Node per idle pod and 2.7× less per live track (see [Measurements](#measurements)). This matters most for the warm pool and the one-track-per-pod design.
- **Half the CPU** of Node on a live track: 7 % against 14 % of a core.
- **A smaller image and a faster start:** a 44 MiB pull against 95 MiB, and 0.2 s against 0.6 s to ready. Both are small next to the roughly 30 s cold start.
- Predictable latency without an event loop.
- The language boundary matches the plane boundary: control plane in TypeScript, translation plane in Go.

### Bad / trade-offs

- Two languages in the monorepo, with separate tooling.
- The shared Zod types are replaced by a schema definition and code generation.
- Nobody on the team has prior Go experience.
- Opus encoding and resampling require cgo (libopus and libsoxr), so the binary is not static and the image needs a Debian base (73 of its 121 MiB unpacked).
- The Go SDKs are confirmed for the job's main path (see [Measurements](#measurements)), but reconnecting after a Gemini `goAway` has not been tested.

### Follow-up work

- **Test what the spike left out:** Gemini session resumption after `goAway` in Go, and a 2-hour track against the pod spec's memory-growth target.
- **Size the pod from the measurements.**
    - CPU request: about `100m`. The `50m` in the pod spec is below the roughly 74m a live track uses.
    - Memory: a smaller request and limit (for example `32Mi` and `64Mi`) than the planned `48Mi` and `128Mi`.
    - `GOMAXPROCS` (for example `2`) set in the manifest. Without a CPU limit, Go uses the node's CPU count.
- Choose the OpenAPI / JSON Schema tooling and code generation, and how Hono produces or consumes it.
