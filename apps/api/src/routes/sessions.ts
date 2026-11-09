import { createSessionRequestSchema, hostTokenResponseSchema, sessionSchema } from "@ads/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../auth/auth.ts";
import { type HostEnv, requireHost } from "../auth/require-host.ts";
import type { BrowserLiveKit } from "../livekit/tokens.ts";
import type { SessionService } from "../sessions/service.ts";
import { validate } from "../validate.ts";

// Host-only session routes, as the PWA calls them (apps/web/src/lib/api.ts).
// A host only ever sees their own sessions: anyone else's is "not found".
// Going live sends one translation job per target language to the translator
// workers (ADR-0018) and, with LiveKit configured, creates the session's rooms
// first (ADR-0020). The workers still use their WAV adapter until they connect
// to LiveKit (YGP-70). While live, the host gets a token to send their mic to
// the source room (YGP-71).

const NOT_FOUND = { message: "Session not found." } as const;
const idParam = z.object({ id: z.string().min(1) });

export function sessionRoutes(auth: Auth, sessions: SessionService, livekit?: BrowserLiveKit) {
  return new Hono<HostEnv>()
    .use(requireHost(auth))
    .post("/", validate("json", createSessionRequestSchema), async (c) => {
      const session = await sessions.create(c.var.host.id, c.req.valid("json"));
      return c.json(sessionSchema.parse(session), 201);
    })
    .get("/:id", validate("param", idParam), async (c) => {
      const session = await sessions.get(c.var.host.id, c.req.valid("param").id);
      return session ? c.json(sessionSchema.parse(session), 200) : c.json(NOT_FOUND, 404);
    })
    .post("/:id/start", validate("param", idParam), async (c) => {
      const session = await sessions.start(c.var.host.id, c.req.valid("param").id);
      return session ? c.json(sessionSchema.parse(session), 200) : c.json(NOT_FOUND, 404);
    })
    .post("/:id/end", validate("param", idParam), async (c) => {
      const session = await sessions.end(c.var.host.id, c.req.valid("param").id);
      return session ? c.json(sessionSchema.parse(session), 200) : c.json(NOT_FOUND, 404);
    })
    // The host's mic token: publish only, in the source room. The identity is
    // the host's own, so a second device takes over from the first (one mic).
    .post("/:id/token", validate("param", idParam), async (c) => {
      if (!livekit) return c.json({ message: "Sending audio isn't available yet: LiveKit isn't connected." }, 501);
      const session = await sessions.get(c.var.host.id, c.req.valid("param").id);
      if (!session) return c.json(NOT_FOUND, 404);
      // The source room exists only while the session is live (YGP-69).
      if (session.status !== "live") return c.json({ message: "This session isn't live." }, 409);
      const token = await livekit.tokens.hostToken(session.id, c.var.host.id);
      return c.json(hostTokenResponseSchema.parse({ serverUrl: livekit.publicUrl, token }), 200);
    });
}
