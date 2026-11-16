import { z } from "zod";

// The internal API between the Hono API and the translator workers (ADR-0018,
// ADR-0020), and the Redis job message. The OpenAPI document
// (openapi/translator-control.yaml) is the source of truth, because the Go
// worker's types are generated from it. These schemas check the requests in
// Hono; test/translator.test.ts fails the type check when they drift from the
// types generated into src/generated/translator-control.ts (`pnpm gen:openapi`).

// Where a translation track stands, as the API stores it. One track is one
// target language of one session.
//   pending: waiting for a worker (a job is on the stream)
//   claimed: a worker owns it and is opening the Gemini stream
//   live:    translated audio flows
//   ended:   the session ended or the worker stopped on its own; never reopened
//   failed:  workers gave up TRACK_MAX_ATTEMPTS times
export const trackStatusSchema = z.enum(["pending", "claimed", "live", "ended", "failed"]);
export type TrackStatus = z.infer<typeof trackStatusSchema>;

export const workerIdSchema = z.string().min(1).max(200);
// Two lowercase letters, as on the wire; the supported list is in languages.ts.
export const trackLanguageSchema = z.string().regex(/^[a-z]{2}$/);

// The fields of one message on the `translate:jobs` stream. All strings.
export const translationJobSchema = z.object({
  v: z.literal("1"),
  jobId: z.string().min(1),
  sessionId: z.string().min(1),
  trackId: z.string().min(1),
  language: trackLanguageSchema,
});
export type TranslationJob = z.infer<typeof translationJobSchema>;

export const claimRequestSchema = z.object({
  workerId: workerIdSchema,
  jobId: z.string().min(1),
});

export const claimResponseSchema = z.object({
  trackId: z.string(),
  sessionId: z.string(),
  language: trackLanguageSchema,
  leaseTtlSec: z.number().int().min(1),
  heartbeatSec: z.number().int().min(1),
  // Only sent when the API has LiveKit configured (ADR-0020).
  livekit: z
    .object({
      url: z.string(),
      sourceToken: z.string(),
      outputToken: z.string(),
    })
    .optional(),
});
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

export const workerStateSchema = z.enum(["connecting", "live", "reconnecting"]);

export const heartbeatStatsSchema = z.object({
  inDroppedFrames: z.number().int().min(0).optional(),
  outBufferMs: z.number().int().min(0).optional(),
  geminiReconnects: z.number().int().min(0).optional(),
});

export const heartbeatRequestSchema = z.object({
  workerId: workerIdSchema,
  state: workerStateSchema,
  stats: heartbeatStatsSchema.optional(),
});

export const heartbeatResponseSchema = z.object({
  leaseTtlSec: z.number().int().min(1),
});

// What a worker may report (the OpenAPI `TrackStatus`): a subset of the stored
// statuses above.
export const reportedStatusSchema = z.enum(["live", "ended", "failed"]);
export type ReportedStatus = z.infer<typeof reportedStatusSchema>;

export const statusRequestSchema = z.object({
  workerId: workerIdSchema,
  status: reportedStatusSchema,
  reason: z.string().max(500).optional(),
});

export const releaseReasonSchema = z.enum(["sigterm"]);

export const releaseRequestSchema = z.object({
  workerId: workerIdSchema,
  reason: releaseReasonSchema,
});

// 409 on claim: drop the job.
export const claimConflictReasonSchema = z.enum(["owned", "ended", "unknown_track"]);
export type ClaimConflictReason = z.infer<typeof claimConflictReasonSchema>;
export const claimConflictSchema = z.object({
  reason: claimConflictReasonSchema,
  message: z.string().optional(),
});

// 409 on heartbeat, status and release: stop working on the track.
export const ownerConflictReasonSchema = z.enum(["not_owner", "ended"]);
export type OwnerConflictReason = z.infer<typeof ownerConflictReasonSchema>;
export const ownerConflictSchema = z.object({
  reason: ownerConflictReasonSchema,
  message: z.string().optional(),
});

export const okSchema = z.object({ ok: z.literal(true) });
