import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { components } from "../src/generated/translator-control.ts";
import {
  claimConflictSchema,
  claimRequestSchema,
  claimResponseSchema,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  okSchema,
  ownerConflictSchema,
  releaseRequestSchema,
  reportedStatusSchema,
  statusRequestSchema,
  translationJobSchema,
} from "../src/index.ts";

type Schemas = components["schemas"];

// Checked by `pnpm typecheck`: each Zod schema has exactly the type the
// OpenAPI document describes (the Go worker's types come from the same file).
describe("translator contract matches the OpenAPI document", () => {
  it("has the same types", () => {
    expectTypeOf<z.infer<typeof translationJobSchema>>().toEqualTypeOf<Schemas["TranslationJob"]>();
    expectTypeOf<z.infer<typeof claimRequestSchema>>().toEqualTypeOf<Schemas["ClaimRequest"]>();
    expectTypeOf<z.infer<typeof claimResponseSchema>>().toEqualTypeOf<Schemas["ClaimResponse"]>();
    expectTypeOf<z.infer<typeof heartbeatRequestSchema>>().toEqualTypeOf<Schemas["HeartbeatRequest"]>();
    expectTypeOf<z.infer<typeof heartbeatResponseSchema>>().toEqualTypeOf<Schemas["HeartbeatResponse"]>();
    expectTypeOf<z.infer<typeof reportedStatusSchema>>().toEqualTypeOf<Schemas["TrackStatus"]>();
    expectTypeOf<z.infer<typeof statusRequestSchema>>().toEqualTypeOf<Schemas["StatusRequest"]>();
    expectTypeOf<z.infer<typeof releaseRequestSchema>>().toEqualTypeOf<Schemas["ReleaseRequest"]>();
    expectTypeOf<z.infer<typeof claimConflictSchema>>().toEqualTypeOf<Schemas["ClaimConflict"]>();
    expectTypeOf<z.infer<typeof ownerConflictSchema>>().toEqualTypeOf<Schemas["OwnerConflict"]>();
    expectTypeOf<z.infer<typeof okSchema>>().toEqualTypeOf<Schemas["Ok"]>();
  });
});

describe("translator requests", () => {
  const workerId = "translator-1-3f9a2c";

  it("accept what the Go worker sends", () => {
    expect(claimRequestSchema.safeParse({ workerId, jobId: "1730000000000-0" }).success).toBe(true);
    expect(
      heartbeatRequestSchema.safeParse({
        workerId,
        state: "live",
        stats: { inDroppedFrames: 0, outBufferMs: 120, geminiReconnects: 1 },
      }).success,
    ).toBe(true);
    expect(statusRequestSchema.safeParse({ workerId, status: "failed", reason: "gemini: retries exhausted" }).success).toBe(true);
    expect(releaseRequestSchema.safeParse({ workerId, reason: "sigterm" }).success).toBe(true);
  });

  it("refuse a missing worker id, unknown states and statuses", () => {
    expect(claimRequestSchema.safeParse({ jobId: "1-0" }).success).toBe(false);
    expect(heartbeatRequestSchema.safeParse({ workerId, state: "sleeping" }).success).toBe(false);
    // Only the API sets pending or claimed.
    expect(statusRequestSchema.safeParse({ workerId, status: "pending" }).success).toBe(false);
    expect(releaseRequestSchema.safeParse({ workerId, reason: "bored" }).success).toBe(false);
  });

  it("check the job message", () => {
    const job = { v: "1", jobId: "j", sessionId: "s", trackId: "t", language: "sk" };
    expect(translationJobSchema.safeParse(job).success).toBe(true);
    expect(translationJobSchema.safeParse({ ...job, v: "2" }).success).toBe(false);
    expect(translationJobSchema.safeParse({ ...job, language: "SK" }).success).toBe(false);
  });
});
