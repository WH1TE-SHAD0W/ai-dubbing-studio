import type { LanguageCode } from "@ads/contracts";
import { AccessToken, type VideoGrant } from "livekit-server-sdk";
import { type LiveKitConfig, outputRoomName, sourceRoomName } from "./rooms.ts";

// LiveKit tokens (ADR-0020, YGP-71). Only Hono holds the LiveKit secret: the
// host, the listeners and the translation workers each get a token for exactly
// the room they need, allowed to do exactly one thing there.
//
// A token only has to be valid when its holder connects; LiveKit keeps the
// connection after that. So every token here is short-lived.
export const TOKEN_TTL_S = 10 * 60;

// Everything is switched off unless a token switches it on, so a token can never
// do more than its comment says. (LiveKit allows publish, subscribe and data
// messages when they're left out.)
const NOTHING: VideoGrant = { canPublish: false, canSubscribe: false, canPublishData: false };

async function sign(config: LiveKitConfig, identity: string, grant: VideoGrant): Promise<string> {
  const token = new AccessToken(config.apiKey, config.apiSecret, { identity, ttl: TOKEN_TTL_S });
  token.addGrant({ ...NOTHING, roomJoin: true, ...grant });
  return token.toJwt();
}

export function createTokenService(config: LiveKitConfig) {
  return {
    // A listener hears one language: subscribe-only, in that output room.
    // `listenerId` is a fresh random ID per listener, as they have no account.
    listenerToken(sessionId: string, language: LanguageCode, listenerId: string): Promise<string> {
      return sign(config, `listener-${listenerId}`, {
        room: outputRoomName(sessionId, language),
        canSubscribe: true,
      });
    },

    // The host sends their microphone once: publish-only, in the source room.
    hostToken(sessionId: string, hostId: string): Promise<string> {
      return sign(config, `host-${hostId}`, {
        room: sourceRoomName(sessionId),
        canPublish: true,
      });
    },

    // A translation worker (one per track) gets two tokens from the claim
    // endpoint: one to hear the host in the source room, and one to publish the
    // dub into its language's output room. In the source room it is hidden, so it
    // doesn't show up as a participant.
    async workerTokens(
      sessionId: string,
      language: LanguageCode,
      workerId: string,
    ): Promise<{ source: string; output: string }> {
      const identity = `worker-${workerId}`;
      const [source, output] = await Promise.all([
        sign(config, identity, { room: sourceRoomName(sessionId), canSubscribe: true, hidden: true }),
        sign(config, identity, { room: outputRoomName(sessionId, language), canPublish: true }),
      ]);
      return { source, output };
    },
  };
}

export type TokenService = ReturnType<typeof createTokenService>;
