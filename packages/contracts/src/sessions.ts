import { z } from "zod";
import { languageCodeSchema } from "./languages.ts";
import { trackStatusSchema } from "./translator.ts";

// Each target language is a separate paid stream; the PoC capped it at 5 (ADR-0009).
export const MAX_TARGET_LANGUAGES = 5;

// Providers the dubbing container has an adapter for (ADR-0009). Gemini only, for now.
export const providerSchema = z.enum(["gemini"]);
export type Provider = z.infer<typeof providerSchema>;

// 6 characters, typed by listeners or read from a QR code (ADR-0014).
// Unique only among sessions that haven't ended (ADR-0002).
export const JOIN_CODE_LENGTH = 6;
export const joinCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6}$/, { error: `Enter the ${JOIN_CODE_LENGTH}-character code.` });

export const sessionStatusSchema = z.enum(["draft", "live", "ended"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const createSessionRequestSchema = z
  .object({
    title: z.string().trim().min(1, { error: "Enter a session title." }).max(120),
    sourceLang: languageCodeSchema,
    targetLangs: z
      .array(languageCodeSchema)
      .min(1, { error: "Pick at least one target language." })
      .max(MAX_TARGET_LANGUAGES, { error: `Pick at most ${MAX_TARGET_LANGUAGES} target languages.` }),
    provider: providerSchema,
    // Speaker consent stays in session creation, as in the PoC (open question in ADR-0009).
    consent: z.object({
      speaker: z.literal(true, { error: "The speaker must agree to voice replication." }),
      aiNotice: z.literal(true, { error: "Listeners must be told the audio is AI-generated." }),
    }),
  })
  .refine((s) => new Set(s.targetLangs).size === s.targetLangs.length, {
    error: "Each target language can be picked once.",
    path: ["targetLangs"],
  })
  .refine((s) => !s.targetLangs.includes(s.sourceLang), {
    error: "A target language can't be the spoken language.",
    path: ["targetLangs"],
  });
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const sessionLanguageSchema = z.object({
  lang: languageCodeSchema,
  peakListeners: z.number().int().nonnegative(),
  // Where this language's translation stands, once the session has started:
  // pending (waiting for a worker), claimed, live, ended or failed (ADR-0018).
  trackStatus: trackStatusSchema.optional(),
});

// A session as the host sees it in the Studio.
export const sessionSchema = z.object({
  id: z.string().min(1),
  joinCode: joinCodeSchema,
  title: z.string(),
  sourceLang: languageCodeSchema,
  languages: z.array(sessionLanguageSchema),
  provider: providerSchema,
  status: sessionStatusSchema,
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
});
export type Session = z.infer<typeof sessionSchema>;
