import { z } from "zod";
import { languageCodeSchema } from "./languages.ts";
import { MAX_TARGET_LANGUAGES, providerSchema } from "./sessions.ts";

// The request Hono sends the dubbing container to start a session (ADR-0009).
// The container stays stateless: everything it needs is in this request.
export const startDubbingSessionRequestSchema = z.object({
  sessionId: z.string().min(1),
  languages: z.object({
    source: languageCodeSchema,
    destinations: z.array(languageCodeSchema).min(1).max(MAX_TARGET_LANGUAGES),
  }),
  provider: providerSchema,
});
export type StartDubbingSessionRequest = z.infer<typeof startDubbingSessionRequestSchema>;
