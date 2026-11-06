# 0018. Autoscaling and job dispatch for translation workers with Redis Streams

- **Status:** Accepted
- **Date:** 2026-11-05
- **Deciders:** Marek Culak
- **Ticket:** YGP-91 & YGP-98

## Context

Translation runs in a pool of worker pods (see 0019). Each pod serves **one track**: one target language of one session. It joins the session's LiveKit source room, holds one Gemini connection and publishes the translated audio into that language's output room (see 0020). The heavy work happens in Gemini, so a pod is light on CPU and RAM, and its life is tied to a session, not to a request.

That shape rules out the usual autoscaling approach. CPU-based scaling reacts only after tracks are already running, and an ordinary scale-down can remove a pod that is mid-session and cut the audio. The platform needs:

- each track job handed to exactly one idle pod,
- a way to recover the job if its pod dies,
- a pool of warm idle pods, because a cold pod takes about 30 s to start, which is acceptable only if the start happens before a session needs it,
- pods that exit after release, so no state carries over and Kubernetes starts a clean replacement.

Constraints: Postgres is the source of truth and is only accessed through Hono, so workers never connect to the database. LiveKit is expected to move to multiple nodes some weeks after the MVP, and its distributed mode needs Redis, so Redis will be part of the platform regardless.

## Options considered

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

Rejected: 2, 3 and 4. Option 2 is the closest competitor. The chosen design also keeps the lease in Postgres and sends claims and heartbeats through Hono, so the difference is delivery: with option 2 idle pods would have to poll Hono for work, while a blocking stream read wakes exactly one idle pod at once. Redis is coming anyway.

## Decision

We dispatch translation jobs through a **Redis Stream with a consumer group**.

- One job per track, carrying only identifiers and minimal metadata (session, track, target language, room names, provider) and no secrets. Hono enqueues the jobs when the session goes live, together with the rooms (0020). Each worker pod reads from the group, so each job goes to exactly one pod.
- **One track per pod.**
- **Postgres is the single source of truth** and is accessed only through Hono. Redis only delivers jobs: the consumer group keeps several pods from fetching the same job and sending needless claims to Hono. Workers get authorisation and report track state through Hono's endpoints (see 0020).
- The pod **acknowledges the job right after Hono accepts its claim**. Hono records the pod as the track's owner in Postgres, with a lease the pod renews by sending Hono a heartbeat every 5 s.
- **Dead workers:** when a lease expires, Hono's lease sweeper sets the track back to pending and enqueues a new job. Pending-entry recovery in Redis (`XAUTOCLAIM`) is not used in the MVP.
- **Fencing:** Hono answers any call from a pod that is not the track's recorded owner with `409`, and that pod stops and exits. A pod replaced after a network hiccup therefore stops at its next call to Hono.
- When Hono reconnects to Redis, it enqueues a job for every track that is pending with no owner, so a Redis restart loses no work. Duplicate jobs are rejected at claim.
- Pods are **single-use**: after release the pod deletes its own pod through the Kubernetes API and exits, and the ReplicaSet creates a fresh pod, so no state or memory carries over between tracks. Simply exiting would make a Deployment restart the container in the same pod, with restart back-off (`CrashLoopBackOff`) after short jobs. An idle pod never exits: it keeps waiting on the stream until it gets a job or a SIGTERM.
- Scaling signal: each pod exposes an idle/busy gauge on its metrics endpoint (busy means it holds a track and a Gemini connection). The autoscaler keeps the number of idle pods above a floor.

## Consequences

### Good

- A job goes to exactly one pod, and Postgres records which pod owns which track.
- Ownership, recovery and fencing live in one place (Postgres through Hono), so Redis holds no state that has to be recovered.
- Single-use pods start clean for every track.
- The idle gauge is a direct capacity signal.
- Redis is already required for multi-node LiveKit, so the end state adds no extra component.

### Bad / trade-offs

- Redis becomes a runtime dependency of session start earlier than LiveKit requires it.
- Hono is on the path of every claim and heartbeat, and a replaced pod may keep publishing until its next call to Hono (up to one heartbeat interval).
- A job lost between enqueue and claim (for example a dropped claim) is only re-enqueued when Hono reconnects to Redis.
- A cold pod takes about 30 s, and spare idle pods cost memory (small with Go, see 0019).
- Scaling is reactive only: there is no scheduled pre-scaling for known conference times.
- One more component to run and clean: the stream needs trimming, and each single-use pod removes its own consumer from the group on exit.
- Workers need permission to delete pods in their namespace to delete themselves; Kubernetes cannot limit that to a pod's own name in advance.
- Scaling on the idle/busy gauge needs KEDA (Prometheus trigger) or a Prometheus adapter, because the HPA alone sees only CPU and memory. CPU is no fallback: a busy pod looks idle while the host is silent.

### Follow-up work

- Deployment ADR: the Role that lets workers delete their own pod, kept to the translator namespace, and the KEDA or Prometheus adapter setup for the idle/busy gauge.
- Use one LiveKit participant identity per track in the output room, so a new owner also disconnects the old one; verify how LiveKit handles a duplicate identity.
- Scale-down must remove idle pods only (for example pod deletion cost); verify with the chosen autoscaler.
- Size the idle-pod floor, the lease TTL (starting at 15 s) and measure the real pod start time.
- Recovery of single lost jobs, beyond re-enqueuing when Hono reconnects to Redis (for example re-enqueue tracks pending for too long).
- Dead-letter handling for jobs that keep failing.
- Revisit if hosts do not send audio straight after the green light: workers claimed when the session goes live then hold idle Gemini connections (see 0020).
- Verify Redis Streams behaviour and version requirements against current documentation.
