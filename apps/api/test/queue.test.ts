import { randomUUID } from "node:crypto";
import { translationJobSchema } from "@ads/contracts";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobQueue, type JobQueue } from "../src/queue/jobs.ts";

// The job stream against a real Redis (`docker compose up -d redis`), read the
// way the Go worker reads it. Needs REDIS_URL (or TEST_REDIS_URL); skipped
// without. Each run uses its own stream.
const REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)("translation job stream against Redis", () => {
  const stream = `test:translate:jobs:${randomUUID()}`;
  const group = "translators";
  let queue: JobQueue;
  let worker: Redis;

  beforeAll(async () => {
    queue = createJobQueue({ url: REDIS_URL!, stream, group });
    worker = new Redis(REDIS_URL!);
    // The queue connects and creates the group in the background.
    await until(async () => (await queue.backlog()) !== null);
  });
  afterAll(async () => {
    await worker?.del(stream);
    await worker?.quit();
    await queue?.close();
  });

  // XREADGROUP as the Go worker sends it (internal/jobs/jobs.go), as consumer `name`.
  async function read(name: string) {
    const res = (await worker.xreadgroup("GROUP", group, name, "COUNT", 1, "STREAMS", stream, ">")) as
      | [string, [string, string[]][]][]
      | null;
    const [, fields] = res?.[0]?.[1][0] ?? [];
    return fields ? Object.fromEntries(fields.flatMap((_, i) => (i % 2 ? [] : [[fields[i], fields[i + 1]]]))) : null;
  }

  it("creates the stream and group, and sends jobs in the contract's shape", async () => {
    const trackId = randomUUID();
    const sessionId = randomUUID();
    const id = await queue.send({ sessionId, trackId, language: "sk" });
    expect(id).toMatch(/^\d+-\d+$/);

    const job = translationJobSchema.parse(await read("translator-a"));
    expect(job).toMatchObject({ v: "1", sessionId, trackId, language: "sk" });
    expect(job.jobId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("counts the messages no worker has taken yet", async () => {
    await queue.send({ sessionId: randomUUID(), trackId: randomUUID(), language: "de" });
    await queue.send({ sessionId: randomUUID(), trackId: randomUUID(), language: "fr" });
    expect(await queue.backlog()).toBe(2);
    await read("translator-a");
    expect(await queue.backlog()).toBe(1);
    await read("translator-a");
    expect(await queue.backlog()).toBe(0);
  });

  it("removes the consumers of workers that stopped reading", async () => {
    await read("translator-gone");
    await new Promise((r) => setTimeout(r, 50));
    const removed = await queue.removeIdleConsumers(20);
    expect(removed).toContain("translator-gone");
    const consumers = (await worker.xinfo("CONSUMERS", stream, group)) as unknown[][];
    expect(consumers.map((c) => c[1])).not.toContain("translator-gone");
  });

  it("fails at once when Redis can't be reached, instead of queueing in memory", async () => {
    const offline = createJobQueue({ url: "redis://127.0.0.1:1", stream, group });
    const started = Date.now();
    await expect(offline.send({ sessionId: "s", trackId: "t", language: "sk" })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(offline.isUp()).toBe(false);
    await offline.close();
  });
});

async function until(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
