import { joinCodeSchema, listenerTokenRequestSchema } from "@ads/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { validate } from "../validate.ts";

// Public listener routes, as the PWA calls them. Placeholders for now: there are
// no stored sessions to look a code up in, and no LiveKit server to issue a
// listener token for (ADR-0001, ADR-0013). The requests are still checked
// against the contract, so a bad code or language gets a real 400.

const codeParam = z.object({ code: joinCodeSchema });

export function joinRoutes() {
  return new Hono()
    .get("/:code", validate("param", codeParam), (c) =>
      c.json({ message: "Joining isn't available yet: sessions aren't stored so far." }, 501),
    )
    .post("/:code/token", validate("param", codeParam), validate("json", listenerTokenRequestSchema), (c) =>
      c.json({ message: "Listening isn't available yet: LiveKit isn't connected." }, 501),
    );
}
