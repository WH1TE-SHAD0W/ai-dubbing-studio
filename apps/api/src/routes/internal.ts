import {
  claimConflictSchema,
  claimRequestSchema,
  heartbeatRequestSchema,
  languageCodeSchema,
  ownerConflictSchema,
  releaseRequestSchema,
  statusRequestSchema,
  type ClaimConflictReason,
  type OwnerConflictReason,
} from "@ads/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { requireInternalToken } from "../auth/require-internal-token.ts";
import type { TokenService } from "../livekit/tokens.ts";
import type { TrackService } from "../tracks/service.ts";
import { validate } from "../validate.ts";

// The translator workers' API (packages/contracts/openapi/translator-control.yaml):
// claim a track after reading its job, renew the lease, report live / ended /
// failed, and give the track back on shutdown. Only the workers call it, with
// the shared INTERNAL_API_TOKEN; it must not be reachable from the internet
// (see docs/api.md).

const trackParam = z.object({ trackId: z.string().min(1) });

const CLAIM_CONFLICT: Record<ClaimConflictReason, string> = {
  owned: "Another worker owns this track.",
  ended: "This track has ended.",
  unknown_track: "There is no such track.",
};
const OWNER_CONFLICT: Record<OwnerConflictReason, string> = {
  not_owner: "This worker no longer owns the track.",
  ended: "This track has ended.",
};

const claimConflict = (reason: ClaimConflictReason) =>
  claimConflictSchema.parse({ reason, message: CLAIM_CONFLICT[reason] });
const ownerConflict = (reason: OwnerConflictReason) =>
  ownerConflictSchema.parse({ reason, message: OWNER_CONFLICT[reason] });

// LiveKit for the workers (ADR-0020). Left out when the API has no LiveKit
// settings; the claim then works as before, without tokens.
export type WorkerLiveKit = { url: string; tokens: TokenService };

export function internalRoutes({
  token,
  tracks,
  livekit,
}: {
  token: string;
  tracks: TrackService;
  livekit?: WorkerLiveKit;
}) {
  return new Hono()
    .use(requireInternalToken(token))
    .post("/tracks/:trackId/claim", validate("param", trackParam), validate("json", claimRequestSchema), async (c) => {
      const { trackId } = c.req.valid("param");
      const { workerId, jobId } = c.req.valid("json");
      const result = await tracks.claim(trackId, workerId, jobId);
      if (!result.ok) return c.json(claimConflict(result.reason), 409);
      if (!livekit) return c.json(result.claim, 200);
      const { sessionId } = result.claim;
      // Tracks only store two letters; their room needs a supported language.
      // A bad code here would be bad data, so a 500 (onError) is right.
      const language = languageCodeSchema.parse(result.claim.language);
      const { source, output } = await livekit.tokens.workerTokens(sessionId, language, workerId);
      return c.json({ ...result.claim, livekit: { url: livekit.url, sourceToken: source, outputToken: output } }, 200);
    })
    .post("/tracks/:trackId/heartbeat", validate("param", trackParam), validate("json", heartbeatRequestSchema), async (c) => {
      const { trackId } = c.req.valid("param");
      const { workerId } = c.req.valid("json");
      const result = await tracks.heartbeat(trackId, workerId);
      return result.ok ? c.json({ leaseTtlSec: result.leaseTtlSec }, 200) : c.json(ownerConflict(result.reason), 409);
    })
    .post("/tracks/:trackId/status", validate("param", trackParam), validate("json", statusRequestSchema), async (c) => {
      const { trackId } = c.req.valid("param");
      const { workerId, status, reason } = c.req.valid("json");
      const result = await tracks.report(trackId, workerId, status, reason);
      return result.ok ? c.json({ ok: true as const }, 200) : c.json(ownerConflict(result.reason), 409);
    })
    .post("/tracks/:trackId/release", validate("param", trackParam), validate("json", releaseRequestSchema), async (c) => {
      const { trackId } = c.req.valid("param");
      const { workerId, reason } = c.req.valid("json");
      const result = await tracks.release(trackId, workerId, reason);
      return result.ok ? c.json({ ok: true as const }, 200) : c.json(ownerConflict(result.reason), 409);
    });
}
