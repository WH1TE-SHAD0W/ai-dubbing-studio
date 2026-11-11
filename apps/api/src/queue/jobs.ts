import { randomUUID } from "node:crypto";
import type { TranslationJob } from "@ads/contracts";
import { Redis } from "ioredis";

// The Redis side of translation jobs (ADR-0018). The API adds one message per
// track to a stream; the translator workers read it as one consumer group, so
// each message goes to one idle worker. Redis only delivers: who owns a track
// is kept in Postgres (tracks/repo.ts). A lost message is sent again by the
// sweeper, and a doubled one is harmless: the second worker's claim gets 409.

export type JobToSend = Pick<TranslationJob, "sessionId" | "trackId" | "language">;

// What the track service needs; tests pass an in-memory one.
export type JobSender = {
  send(job: JobToSend): Promise<string>;
};

export type JobQueue = JobSender & {
  // Messages not yet delivered to any worker, or null when Redis can't tell.
  backlog(): Promise<number | null>;
  // Deletes consumers (workers) not seen for idleMs. Workers that crash leave
  // theirs behind; a running worker reads every second.
  removeIdleConsumers(idleMs: number): Promise<string[]>;
  isUp(): boolean;
  close(): Promise<void>;
};

export type JobQueueOptions = {
  url: string;
  stream: string;
  group: string;
  // Called each time Redis (re)connects, after the group exists. The API sends
  // the jobs of pending tracks again, in case Redis lost them.
  onReady?: () => Promise<void>;
};

// Plenty for the jobs waiting at any time; old, already delivered ones go first.
const MAX_STREAM_LENGTH = 10_000;

export function createJobQueue({ url, stream, group, onReady }: JobQueueOptions): JobQueue {
  const redis = new Redis(url, {
    // Fail at once while disconnected instead of queueing in memory: the track
    // stays unsent in Postgres and the sweeper sends it later.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
  });

  // One line when Redis goes away and one when it is back, not one per retry.
  let down = false;
  redis.on("error", (err: Error) => {
    if (down) return;
    down = true;
    console.error(`redis: ${err.message}; jobs wait in Postgres until it is back`);
  });
  redis.on("ready", () => {
    if (down) console.log("redis: connected again");
    down = false;
    void (async () => {
      try {
        await ensureGroup();
        await onReady?.();
      } catch (err) {
        console.error(`redis: setting up the job stream failed: ${err instanceof Error ? err.message : err}`);
      }
    })();
  });

  // Same as the workers: create the stream and group if missing, from the start.
  async function ensureGroup() {
    try {
      await redis.xgroup("CREATE", stream, group, "0", "MKSTREAM");
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith("BUSYGROUP"))) throw err;
    }
  }

  return {
    async send({ sessionId, trackId, language }) {
      const id = await redis.xadd(
        stream,
        "MAXLEN",
        "~",
        MAX_STREAM_LENGTH,
        "*",
        ...["v", "1", "jobId", randomUUID(), "sessionId", sessionId, "trackId", trackId, "language", language],
      );
      if (!id) throw new Error("redis: XADD returned no id");
      return id;
    },

    async backlog() {
      let groups: unknown;
      try {
        groups = await redis.xinfo("GROUPS", stream);
      } catch {
        return null;
      }
      for (const fields of groups as unknown[][]) {
        const info = pairs(fields);
        if (info.get("name") === group) {
          const lag = info.get("lag");
          return typeof lag === "number" ? lag : null;
        }
      }
      return null;
    },

    async removeIdleConsumers(idleMs) {
      const consumers = (await redis.xinfo("CONSUMERS", stream, group)) as unknown[][];
      const removed: string[] = [];
      for (const fields of consumers) {
        const info = pairs(fields);
        const name = info.get("name");
        const idle = info.get("idle");
        if (typeof name === "string" && typeof idle === "number" && idle > idleMs) {
          await redis.xgroup("DELCONSUMER", stream, group, name);
          removed.push(name);
        }
      }
      return removed;
    },

    isUp: () => redis.status === "ready",

    async close() {
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    },
  };
}

// XINFO answers flat [key, value, key, value, …] lists.
function pairs(fields: unknown[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (let i = 0; i + 1 < fields.length; i += 2) map.set(String(fields[i]), fields[i + 1]);
  return map;
}
