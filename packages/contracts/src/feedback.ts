import { z } from "zod";

// What a listener sends after a session ends. No account, so nothing here is
// required except the message. Everything is length-capped: it ends up in an email.
export const FEEDBACK_MAX_LENGTH = 2000;

export const feedbackRequestSchema = z.object({
  message: z.string().trim().min(1).max(FEEDBACK_MAX_LENGTH),
  rating: z.number().int().min(1).max(5).optional(),
  // Where to reply, if the listener wants an answer.
  email: z.email().max(254).optional(),
  // The session the listener just left, if known.
  sessionId: z.string().min(1).max(100).optional(),
});
export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>;

export const feedbackResponseSchema = z.object({ ok: z.literal(true) });
export type FeedbackResponse = z.infer<typeof feedbackResponseSchema>;
