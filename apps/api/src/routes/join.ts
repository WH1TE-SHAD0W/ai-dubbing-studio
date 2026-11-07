import { joinCodeSchema, joinSessionResponseSchema, listenerTokenRequestSchema } from "@ads/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { SessionService } from "../sessions/service.ts";
import { validate } from "../validate.ts";

// Public listener routes, as the PWA calls them. Looking a session up by its
// join code works; the listener token is a placeholder until a LiveKit server
// is connected (ADR-0001, ADR-0013).

const codeParam = z.object({ code: joinCodeSchema });

export function joinRoutes(sessions: Pick<SessionService, "join">) {
  return new Hono()
    .get("/:code", validate("param", codeParam), async (c) => {
      const found = await sessions.join(c.req.valid("param").code);
      return found ? c.json(joinSessionResponseSchema.parse(found), 200) : c.json({ message: "No session uses this code." }, 404);
    })
    .post("/:code/token", validate("param", codeParam), validate("json", listenerTokenRequestSchema), (c) =>
      c.json({ message: "Listening isn't available yet: LiveKit isn't connected." }, 501),
    );
}
