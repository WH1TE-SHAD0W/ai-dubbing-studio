import { z } from "zod";

// Host account rules from ADR-0003. Better Auth enforces the length on the server;
// the same schema validates the Register and Login forms.
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

// Shown for every failed login, whether the email exists or not (ADR-0003).
export const LOGIN_FAILED_MESSAGE = "Email or password is incorrect.";

// Shown on sign-up when the email already has an account. Saying so is accepted:
// hiding it needs email verification, and the rate limit stops mass checking (ADR-0003).
export const EMAIL_TAKEN_MESSAGE = "This email is already registered. Log in instead.";

// Shown when a new password is on the server's common-password list (ADR-0003).
export const COMMON_PASSWORD_MESSAGE = "This password is too common. Pick a less predictable phrase.";

// Trim and lower-case first, so a pasted " Ana@Example.com " still validates.
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "Enter a valid email address." }));

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, { error: `Use at least ${PASSWORD_MIN} characters.` })
  .max(PASSWORD_MAX, { error: `Use at most ${PASSWORD_MAX} characters.` });

export const registerRequestSchema = z.object({
  name: z.string().trim().min(1, { error: "Enter your name." }).max(80),
  email: emailSchema,
  password: passwordSchema,
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  // Login only checks that something was typed: the length rule is for new passwords.
  password: z.string().min(1, { error: "Enter your password." }),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;
