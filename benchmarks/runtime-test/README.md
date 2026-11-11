# Runtime spike: translator worker RAM, Node vs Go

[ADR-0019](../../docs/adr/0019-translation-worker-runtime.md) (proposed) picks Go
for the translator pod. Its only reason is lower runtime RAM: each pod serves one track,
and a warm pool of idle pods waits for work, so every pod's baseline is paid many times
over. The ADR's first draft guessed "an idle Node pod with the SDKs loaded uses 100–150 MB
and a Go pod 15–40 MB". This spike measured them, and the ADR now quotes the results.

There are two scenarios:

- **Idle:** a warm pod waiting for a job.
- **One live track:** the pod serves one language of a live session through LiveKit and the
  real Gemini Live Translate API.

## What both workers do

[`worker-go/main.go`](worker-go/main.go) and [`worker-node/src/worker.ts`](worker-node/src/worker.ts)
do the same steps, those of the translator pod spec (`apps/translator/pod-spec.md`, §3.1, §4).

**Idle (§4.1 `Idle`):**

1. Load the real SDKs and create the Gemini client and a LiveKit `Room`, without connecting either.
2. Serve `/healthz`, `/readyz` and `/metrics` on `:8080`, with the standard-library HTTP server in each language.
3. Create the Redis consumer group and block on `XREADGROUP … COUNT 1 BLOCK 5000`.

**Live (one job):**

1. `XACK` the job.
2. Join the out room and publish a 24 kHz mono track named after the language.
3. Open Gemini Live Translate. Both workers send the same config as the prototype that ran against the real service: `translationConfig`, input and output transcription, sliding-window compression, session resumption.
4. Join the source room with auto-subscribe off, and subscribe only to the host's audio.
5. Stream the host's audio to Gemini as 16 kHz mono in 100 ms chunks, and write the translated 24 kHz audio to the out track in 10 ms frames.
6. When the rooms are deleted (the session ends), close everything and exit.

| | Go | Node |
|---|---|---|
| LiveKit | `server-sdk-go/v2` 2.19.0 + `pkg/media` (pion, cgo libopus + libsoxr) | `@livekit/rtc-node` 1.2.1 (Rust FFI + libwebrtc) |
| Gemini | `google.golang.org/genai` 1.77.0 | `@google/genai` 2.32.0 |
| Redis | `go-redis/v9` 9.23.0 | `ioredis` 6.0.0 |
| Metrics | `prometheus/client_golang` 1.25.0 | `prom-client` 15.1.3 |
| Toolchain | Go 1.27.3, `CGO_ENABLED=1`, `-trimpath -ldflags="-s -w"` | Node 24, `tsc`, plain `node` |
| Runtime image | `debian:bookworm-slim` + `libopus0`, `libsoxr0` | `node:24-bookworm-slim` |

Neither worker has memory tuning (no `GOMEMLIMIT`, no Node heap flags).

The [`harness/`](harness/) runs around the workers. None of it is measured. It contains:

| File | Role |
|---|---|
| `host.ts` | Joins `src-spike` as the host and loops a 51 s text-to-speech recording |
| `dispatch.ts` | Mints the worker's tokens, `XADD`s the job, and deletes the rooms at the end |
| `listener.ts` | Subscribes to the dubbed track and counts the audio it hears |
| `make-speech-wav.ps1` | Writes the host's recording with Windows text-to-speech |

The tools use the same SDKs as the workers (`@livekit/rtc-node`, `livekit-server-sdk`,
`ioredis`). LiveKit is the real `livekit-server`, run with `--dev` in Docker. Gemini is
the real Gemini Live API. Nothing is mocked.

## Run it

You need Docker and Node 24. Go doesn't have to be installed: it builds in the container.

```bash
docker compose -f benchmarks/runtime-test/docker-compose.yml --profile go --profile node --profile live build
```

```bash
node benchmarks/runtime-test/measure.mjs --runtime go
```

```bash
node benchmarks/runtime-test/measure.mjs --runtime node
```

For the live track you need real speech for the host. On Windows, this generates it:

```bash
powershell -ExecutionPolicy Bypass -File benchmarks/runtime-test/harness/make-speech-wav.ps1
```

Then run the live scenario:

```bash
node benchmarks/runtime-test/measure.mjs --runtime go --scenario live
```

```bash
node benchmarks/runtime-test/measure.mjs --runtime node --scenario live
```

`--scenario live` uses the **real Gemini API**, with `GEMINI_API_KEY` and `GEMINI_MODEL`
from the repo-root `.env`. Only those two values reach the worker container, and the key
is never printed. Each run streams for `--minutes`, so **every minute is a paid Gemini
session**. The live scenario also needs `harness/audio/speech.wav` (see above), which is
git-ignored.

Defaults are 3 runs × 5 minutes, and the medians are taken over the last 3 minutes. Change
them with `--runs`, `--minutes` and `--window`.

Other options:

- `--tag` keeps a variant's results apart.
- `--gomaxprocs N` sets `GOMAXPROCS` in the Go worker.

The script writes one CSV per run, `summary.json` and `summary.md` (all runs) to [`results/`](results/).

## What is measured, and which number to use

`measure.mjs` reads memory in three ways.

**Working set** (cgroup `memory.current − inactive_file`)

- Read every second from outside the container through the Docker Engine API, so sampling adds nothing to the container.
- This is the number kubelet uses for eviction, the one `kubectl top` shows, and the one a **memory limit** is checked against.
- File pages count toward the cgroup that first read them. The image files were already in the page cache, so this is almost all the process's own memory.
- On a node with many identical pods it is what **each extra pod** costs.

**RSS** (`process_resident_memory_bytes`)

- The process's view.
- It also counts the mapped pages of the binary and its shared libraries (`RssFile`): `node` plus the 26 MB LiveKit `.so` in Node, the 42 MB Go binary in Go.
- Those pages are shared between pods running the same image. RSS is therefore the upper bound: roughly what the **first pod on a node** costs, and the worst case a pod's cgroup can be charged.

**Heap**

- Go: `go_memstats_heap_inuse_bytes`.
- Node: `nodejs_heap_size_used_bytes`, plus `nodejs_external_memory_bytes`.
- Separates the program's own data from the runtime and its libraries.

## Results

Docker Desktop 29 on WSL2: kernel 6.6, x86-64, 16 CPUs, cgroup v2. Medians; [`results/summary.md`](results/summary.md) has every run.

### Idle

| | Go | Node | Node ÷ Go |
|---|---|---|---|
| **Working set** (3 × 5 min) | **18.9 MiB** | **36.8 MiB** | 1.9× |
| Working set, 15 min run | 20.4 MiB | 39.4 MiB | 1.9× |
| Working set, Go with `GOMAXPROCS=2` | 13.3 MiB | – | – |
| **RSS** | **43.8 MiB** | **87.5 MiB** | 2.0× |
| ├ own memory (RssAnon) | 20.2 MiB | 35.2 MiB | |
| └ shared file pages (RssFile) | 27.2 MiB | 53.6 MiB | |
| Heap | 15.6 MiB | 16.5 MiB + 5.2 MiB external | |
| Peak working set | 21.6 MiB | 52.8 MiB (start-up, before the first GC) | |
| CPU | 0.00 % | 0.74 % | |
| Container start → ready | 193 ms | 631 ms | |
| Image, unpacked files | 121 MiB | 285 MiB | 2.4× |
| Image, `docker save` gzipped (≈ pull) | 44 MiB | 95 MiB | 2.2× |

### One live track (real Gemini Live Translate)

Three runs × 5 minutes per runtime. Each pod got one job, went live and translated the
looped speech into Slovak. The listener received translated sound in every run: 215–236 s
out of each 5 minutes.

| | Go | Node | Node ÷ Go |
|---|---|---|---|
| **Working set** | **22.7 MiB** | **62.3 MiB** | 2.7× |
| Peak working set | 24.6 MiB | 84.1 MiB (first ~2 min, before V8 shrinks its heap) | 3.4× |
| **RSS** | **51.0 MiB** | **122.6 MiB** | 2.4× |
| ├ own memory (RssAnon) | 20.2 MiB | 51.6 MiB | |
| └ shared file pages (RssFile) | 32.0 MiB | 65.1 MiB | |
| Heap | 12.7 MiB | 19.5 MiB + 5.9 MiB external | |
| Growth over idle (working set) | +3.8 MiB | +25.5 MiB | |
| CPU (share of one core) | 7.4 % | 13.9 % (8–18 % between runs) | 1.9× |
| Job received → live | 469 ms | 581 ms | |
| Rooms deleted → worker exits | 36 ms | 40 ms | |

Both workers wrote 299 s of translation to the out track per run.

Go sent 263 s of host audio to Gemini and Node sent 301 s. The likely reason is that
Go's `PCMRemoteTrack` only yields samples for the packets it receives, skipping Opus
silence between sentences, while rtc-node's `AudioStream` yields frames continuously.
The translated output was the same.

### Projection

| | Go | Node |
|---|---|---|
| Each extra busy pod | ≈ 23 MiB | ≈ 62 MiB |
| Each extra idle (warm) pod | ≈ 19–20 MiB | ≈ 37–39 MiB |
| 100 busy tracks + 3 warm pods | ≈ 2.3 GiB | ≈ 6.2 GiB |
| Busy pods per GiB of node memory | ≈ 45 | ≈ 16 |
| Shared image pages, once per node | ≈ 32 MiB | ≈ 65 MiB |

## Findings

1. **The numbers back ADR-0019, but the ADR should quote them instead of its estimate.**
   - Idle Node is lower than the ADR guessed: 37–39 MiB working set and 88 MiB RSS, against its 100–150 MB. Idle Go is within its range: 19–20 MiB and 44 MiB.
   - The gap is about 2× idle and about 2.7× while serving a track. Busy is where most of a pod's time is spent and what the memory limit has to cover.
2. **Node's extra memory on a live track is the LiveKit native runtime.** rtc-node starts its Rust/libwebrtc runtime on the first `connect`, and the working set grows by about 26 MiB. Go's pion stack grows it by about 4 MiB.
3. **Memory limits from the pod spec** (requests 48Mi, limit 128Mi):
   - **Go**, at 23–25 MiB, has plenty of room. It could run with a 32Mi request and a 64Mi limit.
   - **Node** fits under 128Mi, but its own (anonymous) memory reaches about 77 MiB in the first two minutes. If the pod is the first on its node, the cgroup is also charged its 65 MiB of file pages. Those pages can be reclaimed, so it would slow down rather than be killed, but Node would need at least a 128Mi limit and a 64Mi request.
4. **The CPU request in the pod spec is too low for both.** `50m` is 5 % of a core, and a busy pod uses about 74m (Go) or about 140m (Node). Suggested starting points: `100m` for Go and `200m` for Node.
5. **Go's idle memory depends on `GOMAXPROCS`.** On this 16-CPU machine Go idles at 19–20 MiB. With `GOMAXPROCS=2` it idles at 13 MiB, because each P (one per CPU) holds its own partly used heap spans until a GC.
   - Go 1.25+ uses the container's CPU **limit** for `GOMAXPROCS`. The pod spec sets only a request, so on a large node set `GOMAXPROCS` (for example `2`) in the manifest.
6. **The Go SDKs work for this job against the real services.** These all ran as needed:
   - Gemini Live Translate (`TranslationConfig`), session resumption and compression;
   - the LiveKit PCM tracks in and out, auto-subscribe off, and leaving when the room is deleted.
   This retires the ADR's "Go SDK support … not yet confirmed" risk for the parts tested here.
7. **Images.** Neither image can use the smallest base.
   - Go needs cgo for libopus and libsoxr (which pulls in libgomp), so it can't be a static binary on `distroless/static`. `debian:bookworm-slim` is 73 of its 121 MiB.
   - rtc-node ships only glibc builds, so the Node image can't use Alpine.
   - The pull is about 44 MiB for Go and 95 MiB for Node. Start → ready is 0.2 s vs 0.6 s, which is small next to the ~30 s cold start either way.

## Limits of this spike

- **One machine.** Kubernetes (Minikube) should show the same per-container numbers, but this was not checked.
- **A 5-minute track, not a 2-hour one.** The pod-spec target ("RSS growth < 10 MB over 2 hours") is not tested.
- **One track per run, alone on the machine.** There is no CPU contention from other pods.
- **The input is a looped recording**, not a live microphone.
- **The job is a shortcut.** It carries the LiveKit tokens, where the real worker fetches them through `/claim` (pod-spec D4). Heartbeats and Gemini reconnects aren't implemented, so neither worker carries their (small) cost.
- **Not the same build for both scenarios.** The idle runs were measured before the live path was finished: the job code was the same, but there were no sample counters, and the Gemini config differed only in code that idle never runs.
- **No `livekit-server-sdk` in the Node worker.** The worker never mints tokens (D4), so it doesn't need that library.
