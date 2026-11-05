import { z } from "zod";
import { languageCodeSchema } from "./languages.ts";
import { sessionStatusSchema } from "./sessions.ts";

// What a listener sees after entering a join code. Listeners have no account.
export const joinSessionResponseSchema = z.object({
  title: z.string(),
  hostName: z.string(),
  sourceLang: languageCodeSchema,
  languages: z.array(languageCodeSchema).min(1),
  status: sessionStatusSchema,
});
export type JoinSessionResponse = z.infer<typeof joinSessionResponseSchema>;

export const listenerTokenRequestSchema = z.object({
  lang: languageCodeSchema,
});
export type ListenerTokenRequest = z.infer<typeof listenerTokenRequestSchema>;

// Each language has its own LiveKit room; the token only lets the listener subscribe.
export const listenerTokenResponseSchema = z.object({
  serverUrl: z.url({ protocol: /^wss?$/ }),
  token: z.string().min(1),
});
export type ListenerTokenResponse = z.infer<typeof listenerTokenResponseSchema>;
