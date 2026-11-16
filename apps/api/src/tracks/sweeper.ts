import type { JobQueue } from "../queue/jobs.ts";
import type { TrackService } from "./service.ts";

// Keeps tracks moving when something goes wrong between Postgres and Redis
// (ADR-0018). Every few seconds it:
//   1. takes tracks back from workers whose lease ran out (crashed or cut off)
//      and sends their jobs again;
//   2. sends jobs that couldn't be sent (Redis was down);
//   3. re-sends jobs sent a while ago that no worker claimed, but only when
//      every message on the stream has been delivered: then the job was lost
//      (a worker died between reading and claiming). While messages still wait
//      for a free worker, re-sending would only pile up copies.
// And every minute it deletes the stream consumers of workers that are gone.

export type SweeperOptions = {
  tracks: Pick<TrackService, "expireLeases" | "sendPending">;
  queue: Pick<JobQueue, "backlog" | "removeIdleConsumers">;
  everyMs?: number;
  staleAfterSec?: number;
  consumerIdleMs?: number;
};

export type Sweeper = {
  // One pass, as the timer runs it (tests call it directly).
  runOnce(): Promise<void>;
  // Stops the timer and waits for a pass in progress.
  stop(): Promise<void>;
};

export function startSweeper({
  tracks,
  queue,
  everyMs = 5_000,
  staleAfterSec = 30,
  consumerIdleMs = 60_000,
}: SweeperOptions): Sweeper {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> | undefined;
  let lastConsumerSweep = Date.now();
  let lastError = "";

  async function runOnce() {
    await tracks.expireLeases();
    const backlog = await queue.backlog();
    await tracks.sendPending(backlog === 0 || backlog === null ? staleAfterSec : null);
    if (Date.now() - lastConsumerSweep >= consumerIdleMs) {
      lastConsumerSweep = Date.now();
      const removed = await queue.removeIdleConsumers(consumerIdleMs);
      if (removed.length > 0) console.log(`tracks: removed ${removed.length} stream consumer(s) of stopped workers`);
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      current = runOnce()
        .then(() => {
          lastError = "";
        })
        .catch((err: unknown) => {
          // Postgres or Redis is down: say so once, keep trying.
          const message = err instanceof Error ? err.message : String(err);
          if (message !== lastError) console.error(`tracks: sweeper: ${message}`);
          lastError = message;
        })
        .finally(() => {
          current = undefined;
          schedule();
        });
    }, everyMs);
    timer.unref();
  }

  schedule();
  return {
    runOnce,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}
