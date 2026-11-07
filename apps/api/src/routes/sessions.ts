import { createSessionRequestSchema, sessionSchema } from "@ads/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../auth/auth.ts";
import { type HostEnv, requireHost } from "../auth/require-host.ts";
import type { SessionService } from "../sessions/service.ts";
import { validate } from "../validate.ts";

// Host-only session routes, as the PWA calls them (apps/web/src/lib/api.ts).
// A host only ever sees their own sessions: anyone else's is "not found".
// Going live sends one translation job per target language to the translator
// workers (ADR-0018); LiveKit isn't connected yet, so the audio comes from the
// workers' WAV adapter for now.

const NOT_FOUND = { message: "Session not found." } as const;
const idParam = z.object({ id: z.string().min(1) });

export function sessionRoutes(auth: Auth, sessions: SessionService) {
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
    });
}
