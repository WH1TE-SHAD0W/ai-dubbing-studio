import { z } from "zod";

// The body of every error the API returns, Better Auth's included. The PWA shows
// `message` to the user, so it is written for people, not for logs.
export const apiErrorSchema = z.object({
  message: z.string().min(1),
  // Better Auth adds a machine-readable code (e.g. "INVALID_EMAIL_OR_PASSWORD").
  code: z.string().optional(),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

// Shown for every rate-limited request (429).
export const RATE_LIMITED_MESSAGE = "Too many attempts. Wait a minute and try again.";
