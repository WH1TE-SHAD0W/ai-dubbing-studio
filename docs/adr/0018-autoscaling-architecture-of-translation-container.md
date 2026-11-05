## 0018. Autoscaling and job dispatch for translation workers with Redis Streams

- **Status:** Proposed
- **Date:** 2026-11-05
- **Deciders:** Marek Culak
- **Ticket:** YGP-91 & YGP-98

### Context

Translation runs in a pool of worker pods (see 0019). Each pod serves **one track**: one target language of one session. It joins the session's LiveKit source room, holds one Gemini connection and publishes the translated audio into that language's output room (see 0020). The heavy work happens in Gemini, so a pod is light on CPU and RAM, and its life is tied to a session, not to a request.

That shape rules out the usual autoscaling approach. CPU-based scaling reacts only after tracks are already running, and an ordinary scale-down can remove a pod that is mid-session and cut the audio. The platform needs:

- each track job handed to exactly one idle pod,
- a way to recover the job if its pod dies,
- a pool of warm idle pods, because a cold pod takes about 30 s to start, which is acceptable only if the start happens before a session needs it,
- pods that exit after release, so no state carries over and Kubernetes starts a clean replacement.

Constraints: Postgres is the source of truth and is only accessed through Hono, so workers never connect to the database. LiveKit is expected to move to multiple nodes some weeks after the MVP, and its distributed mode needs Redis, so Redis will be part of the platform regardless.

### Options considered

1. **Redis Streams with a consumer group**
    - Pros: each job is delivered to exactly one consumer; a delivered job stays on a pending list until it is acknowledged, so unfinished jobs can be reclaimed from a dead consumer; blocking reads wake idle pods immediately; dispatch and recovery live in one structure; Redis arrives anyway with multi-node LiveKit; mature Go clients.
    - Cons: another component to run and persist before LiveKit needs it; delivery is at-least-once, so a slow or partitioned worker can be reclaimed from while it is still running and two pods could serve one track unless ownership is fenced; the stream and stale consumers need cleanup.
2. **Postgres queue (`SELECT ... FOR UPDATE SKIP LOCKED` plus a lease table)**
    - Pros: no new component; queue and session state in one transaction; about a hundred tracks is far below what it handles.
    - Cons: workers would need database credentials, which breaks "the DB is only accessed through Hono", or every claim and heartbeat goes through a Hono endpoint; lease expiry and the reaper are hand-written; wake-up needs polling or LISTEN/NOTIFY; Redis is still needed later for LiveKit, so two mechanisms end up running.
3. **RabbitMQ**
    - Pros: mature acknowledgements; a message is redelivered when the consumer's connection drops, so a dead worker is detected by the connection; a pod can hold one message unacknowledged for the life of its track.
    - Cons: another broker next to Redis, which LiveKit needs anyway; long-held unacknowledged messages run into the broker's consumer acknowledgement timeout, which would have to be raised above the longest conference (current default to verify); no gain over Streams at this volume.
4. **Kafka**
    - Pros: very high throughput and durable ordered logs.
    - Cons: consumers own partitions, not individual jobs, and there is no per-job acknowledgement or lease; assigning one track to one pod and reclaiming it when the pod dies means working against partition assignment and rebalancing; heavy for about a hundred jobs.

Rejected: 2, 3 and 4. Option 2 is the closest competitor and is rejected because workers would either touch the database directly or push all claim traffic through Hono, and Redis is coming anyway.

### Decision

We dispatch translation jobs through a **Redis Stream with a consumer group**.

- One job per track, carrying only identifiers and minimal metadata (session, track, target language, room names, provider) and no secrets. Hono enqueues the jobs when the session is created, together with the rooms (0020). Each worker pod reads from the group, so each job goes to exactly one pod.
- **One track per pod.**
- The job stays pending until it is acknowledged when the track is released.
- Postgres stays the single source of truth and is accessed only through Hono. Redis holds only the queue and in-flight state. Workers get authorisation and report track state through Hono's endpoints (see 0020).
- Pods **exit after release**. The Kubernetes autoscaler creates replacements, so no state or memory carries over between tracks.
- Scaling signal: each pod exposes an idle/busy gauge on its metrics endpoint (busy means it holds a track and a Gemini connection). The autoscaler keeps the number of idle pods above a floor.
- How a dead worker is detected is **not decided here** (see follow-up work).

### Consequences

**Good**

- A job goes to exactly one pod, and the pending list shows which pod holds which track.
- Unfinished jobs stay pending and can be reclaimed, so recovery needs no hand-written queue code.
- Single-use pods start clean for every track.
- The idle gauge is a direct capacity signal.
- Redis is already required for multi-node LiveKit, so the end state adds no extra component.

**Bad / trade-offs**

- Redis becomes a runtime dependency of session start earlier than LiveKit requires it.
- At-least-once delivery means duplicate work is possible, so ownership needs fencing.
- A cold pod takes about 30 s, and spare idle pods cost memory (small with Go, see 0019).
- Scaling is reactive only: there is no scheduled pre-scaling for known conference times.
- One more state store to persist and clean (stream trimming, stale consumers).

**Follow-up work**

- Open: choose the liveness mechanism. Candidates are pending-list entries kept alive by a heartbeat with a reaper reclaiming idle entries, a separate TTL lease key per track, or heartbeats sent to Hono's API (as in the sequence diagram). Decide TTL and heartbeat interval.
- Fence ownership so a reclaimed track never runs twice (for example one LiveKit participant identity per track; verify how LiveKit handles a duplicate identity).
- Scale-down must remove idle pods only (for example pod deletion cost); verify with the chosen autoscaler.
- Size the idle-pod floor and measure the real pod start time.
- Define recovery when Redis loses data (persistence settings; for example re-enqueue tracks of live sessions from Postgres).
- Dead-letter handling for jobs that keep failing.
- Revisit if hosts do not send audio straight after the green light: workers claimed at session creation then hold idle Gemini connections (see 0020).
- Verify Redis Streams behaviour and version requirements against current documentation.
