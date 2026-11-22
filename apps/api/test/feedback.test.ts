import { randomUUID } from "node:crypto";
import { RATE_LIMITED_MESSAGE, apiErrorSchema, feedbackResponseSchema } from "@ads/contracts";
import { Hono } from "hono";
import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clientIp } from "../src/auth/client-ip.ts";
import { oneLine } from "../src/mail/mailer.ts";
import { createRateLimiter } from "../src/mail/rate-limit.ts";
import { feedbackRoutes } from "../src/routes/feedback.ts";

// Listener feedback (YGP-119): the route with a fake mailer and an in-memory
// counter, then the Redis counter itself (needs REDIS_URL, skipped without).
// A real Gmail send is YGP-121.

const counts = new Map<string, number>();
const fakeRedis = {
  incr: async (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1).get(k)!,
  expire: async () => 1,
};
const limiter = createRateLimiter(fakeRedis, { prefix: "t", limit: 3, windowSec: 60 });

describe("POST /api/feedback", () => {
  const sent: { subject: string; text: string; replyTo?: string }[] = [];
  let failMail = false;
  const mailer = {
    send: async (mail: (typeof sent)[number]) => {
      if (failMail) throw new Error("535 bad credentials for secret-user");
      sent.push(mail);
    },
  };
  const app = new Hono().route("/api/feedback", feedbackRoutes({ mailer, limiter }, (c) => clientIp(c)));
  const noMail = new Hono().route("/api/feedback", feedbackRoutes(undefined, (c) => clientIp(c)));

  const post = (body: unknown, ip = "10.0.0.1", target = app) =>
    target.request("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    sent.length = 0;
    counts.clear();
    failMail = false;
  });

  it("emails the feedback as plain text and answers ok", async () => {
    const res = await post({ message: "  Loved it  ", rating: 4, email: "a@b.example", sessionId: "s-1" });
    expect(res.status).toBe(200);
    expect(feedbackResponseSchema.parse(await res.json())).toEqual({ ok: true });
    expect(sent).toEqual([
      { subject: "Listener feedback (4/5)", text: "Rating: 4/5\nEmail: a@b.example\nSession: s-1\n\nLoved it", replyTo: "a@b.example" },
    ]);
  });

  it("needs only a message", async () => {
    expect((await post({ message: "Hi" })).status).toBe(200);
    expect(sent[0]!.text).toContain("Email: not given");
  });

  it("answers 400 to a bad body and sends nothing", async () => {
    for (const body of [{}, { message: "   " }, { message: "x".repeat(2001) }, { message: "ok", rating: 9 }, { message: "ok", email: "nope" }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(sent).toEqual([]);
  });

  it("answers 429 after the limit, per client IP", async () => {
    for (let i = 0; i < 3; i++) expect((await post({ message: "hi" }, "10.0.0.5")).status).toBe(200);
    const res = await post({ message: "hi" }, "10.0.0.5");
    expect(res.status).toBe(429);
    expect(apiErrorSchema.parse(await res.json()).message).toBe(RATE_LIMITED_MESSAGE);
    expect(sent).toHaveLength(3);
    expect((await post({ message: "hi" }, "10.0.0.6")).status).toBe(200);
  });

  it("answers 502 without the mail error when sending fails", async () => {
    failMail = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ message: "hi" });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toMatch(/535|secret-user/);
    vi.restoreAllMocks();
  });

  it("answers 501 when mail isn't configured", async () => {
    expect((await post({ message: "hi" }, "10.0.0.1", noMail)).status).toBe(501);
  });
});

describe("client IP and mail headers", () => {
  const ipFor = async (xff: string, trusted: string[]) => {
    let ip = "";
    await new Hono()
      .get("/", (c) => ((ip = clientIp(c, trusted)), c.text("")))
      .request("/", { headers: { "x-forwarded-for": xff } });
    return ip;
  };

  it("skips trusted proxies from the right, so a client can't pick its bucket", async () => {
    expect(await ipFor("1.1.1.1", [])).toBe("1.1.1.1");
    expect(await ipFor("9.9.9.9, 1.1.1.1, 10.0.0.2", ["10.0.0.0/8"])).toBe("1.1.1.1");
  });

  it("makes a header value one line", () => {
    expect(oneLine("Hi\r\nBcc: evil@example.com")).toBe("Hi Bcc: evil@example.com");
  });
});

const REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)("the rate limiter against Redis", () => {
  const redis = new Redis(REDIS_URL!);
  afterAll(() => redis.quit());

  it("allows the limit, then refuses, and the key expires", async () => {
    const prefix = `test:feedback:${randomUUID()}`;
    const real = createRateLimiter(redis, { prefix, limit: 2, windowSec: 60 });
    expect([await real.allow("ip"), await real.allow("ip"), await real.allow("ip")]).toEqual([true, true, false]);
    expect(await real.allow("other")).toBe(true);
    expect(await redis.ttl(`${prefix}:ip`)).toBeGreaterThan(0);
    await redis.del(`${prefix}:ip`, `${prefix}:other`);
  });
});
