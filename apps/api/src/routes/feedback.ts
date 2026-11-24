import { FEEDBACK_MAX_LENGTH, FEEDBACK_RATE_LIMITED_MESSAGE, feedbackRequestSchema, feedbackResponseSchema } from "@ads/contracts";
import type { Context } from "hono";
import { Hono } from "hono";
import type { Mailer } from "../mail/mailer.ts";
import type { RateLimiter } from "../mail/rate-limit.ts";
import { validate } from "../validate.ts";

// Public: a listener's feedback after a session ends (YGP-119). It goes to the
// team inbox as a plain-text email. The body is never logged, and neither the
// mail error nor the mail settings reach the answer. Rate limited per client IP.

export function feedbackRoutes(feedback: { mailer: Mailer; limiter: RateLimiter } | undefined, ipOf: (c: Context) => string) {
  return new Hono().post("/", validate("json", feedbackRequestSchema), async (c) => {
    if (!feedback) return c.json({ message: "Feedback isn't available yet: email isn't set up." }, 501);
    const { mailer, limiter } = feedback;
    try {
      if (!(await limiter.allow(ipOf(c)))) return c.json({ message: FEEDBACK_RATE_LIMITED_MESSAGE }, 429);
    } catch (err) {
      console.error("feedback: rate limiter failed:", err instanceof Error ? err.message : err);
      return c.json({ message: "Feedback isn't available right now. Try again later." }, 503);
    }

    const { message, rating, email, sessionId } = c.req.valid("json");
    const lines = [
      rating ? `Rating: ${rating}/5` : "Rating: none",
      `Email: ${email ?? "not given"}`,
      `Session: ${sessionId ?? "not given"}`,
      "",
      message.slice(0, FEEDBACK_MAX_LENGTH),
    ];
    try {
      await mailer.send({ subject: rating ? `Listener feedback (${rating}/5)` : "Listener feedback", text: lines.join("\n"), replyTo: email });
    } catch (err) {
      // The error can carry the server's reply; log only its kind.
      console.error("feedback: sending the email failed:", err instanceof Error ? err.name : "unknown error");
      return c.json({ message: "We couldn't send your feedback. Try again later." }, 502);
    }
    return c.json(feedbackResponseSchema.parse({ ok: true }), 200);
  });
}
