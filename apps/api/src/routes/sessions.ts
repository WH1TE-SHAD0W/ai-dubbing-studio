import { createSessionRequestSchema } from "@ads/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../auth/auth.ts";
import { type HostEnv, requireHost } from "../auth/require-host.ts";
import { validate } from "../validate.ts";

// Host-only session routes, as the PWA calls them (apps/web/src/lib/api.ts).
// Placeholders for now: the login check and the request checks are real, but
// sessions aren't stored yet and the dubbing container isn't called (ADR-0009),
// so each answers 501 with a message the Studio shows.

const NOT_BUILT = { message: "Sessions aren't available yet. Only logging in works so far." } as const;
const idParam = z.object({ id: z.string().min(1) });

export function sessionRoutes(auth: Auth) {
  return new Hono<HostEnv>()
    .use(requireHost(auth))
    .post("/", validate("json", createSessionRequestSchema), (c) => c.json(NOT_BUILT, 501))
    .get("/:id", validate("param", idParam), (c) => c.json(NOT_BUILT, 501))
    .post("/:id/start", validate("param", idParam), (c) => c.json(NOT_BUILT, 501))
    .post("/:id/end", validate("param", idParam), (c) => c.json(NOT_BUILT, 501));
}
