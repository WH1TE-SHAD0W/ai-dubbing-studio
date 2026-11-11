import { randomUUID } from "node:crypto";
import {
  joinCodeSchema,
  joinSessionResponseSchema,
  listenerTokenRequestSchema,
  listenerTokenResponseSchema,
} from "@ads/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { BrowserLiveKit } from "../livekit/tokens.ts";
import type { SessionService } from "../sessions/service.ts";
import { validate } from "../validate.ts";

// Public listener routes, as the PWA calls them. Listeners have no account: a
// join code and a language get them a LiveKit token that can only listen, in
// that language's output room (ADR-0020, YGP-71). Without LiveKit configured,
// the token route answers 501.

const codeParam = z.object({ code: joinCodeSchema });

export function joinRoutes(sessions: Pick<SessionService, "join" | "listenerSession">, livekit?: BrowserLiveKit) {
  return new Hono()
    .get("/:code", validate("param", codeParam), async (c) => {
      const found = await sessions.join(c.req.valid("param").code);
      return found ? c.json(joinSessionResponseSchema.parse(found), 200) : c.json({ message: "No session uses this code." }, 404);
    })
    .post("/:code/token", validate("param", codeParam), validate("json", listenerTokenRequestSchema), async (c) => {
      if (!livekit) return c.json({ message: "Listening isn't available yet: LiveKit isn't connected." }, 501);
      const { code } = c.req.valid("param");
      const { lang } = c.req.valid("json");

      // Rooms exist only while the session is live (YGP-69).
      const session = await sessions.listenerSession(code);
      if (!session || session.status !== "live") return c.json({ message: "This session isn't live." }, 404);
      if (!session.languages.includes(lang)) {
        return c.json({ message: "This session isn't translated into that language." }, 400);
      }

      // A fresh id per token: listeners are anonymous, and two on the same
      // phone must not knock each other out of the room.
      const token = await livekit.tokens.listenerToken(session.id, lang, randomUUID());
      return c.json(listenerTokenResponseSchema.parse({ serverUrl: livekit.publicUrl, token }), 200);
    });
}
