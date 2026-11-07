import { TokenVerifier } from "livekit-server-sdk";
import { describe, expect, it } from "vitest";
import { TOKEN_TTL_S, createTokenService } from "../src/livekit/tokens.ts";

// LiveKit tokens (YGP-71). The first part reads each token back and checks
// exactly what it allows; it needs no server. The second part asks a real
// LiveKit whether it accepts them, and needs LIVEKIT_URL, LIVEKIT_API_KEY and
// LIVEKIT_API_SECRET (skipped without them).

const SESSION = "3f0c2b7e-0000-4000-8000-000000000001";

describe("what each token allows", () => {
  const config = { url: "ws://unused", apiKey: "test-key", apiSecret: "test-secret-".repeat(4) };
  const tokens = createTokenService(config);
  const read = (token: string) => new TokenVerifier(config.apiKey, config.apiSecret).verify(token);

  it("lets a listener only listen, in their language's output room", async () => {
    const claims = await read(await tokens.listenerToken(SESSION, "de", "abc"));
    expect(claims.sub).toBe("listener-abc");
    expect(claims.video).toMatchObject({
      room: `ses-${SESSION}-de-0`,
      roomJoin: true,
      canSubscribe: true,
      canPublish: false,
      canPublishData: false,
    });
  });

  it("lets the host only send their microphone, in the source room", async () => {
    const claims = await read(await tokens.hostToken(SESSION, "host-user-1"));
    expect(claims.sub).toBe("host-host-user-1");
    expect(claims.video).toMatchObject({
      room: `ses-${SESSION}-src`,
      roomJoin: true,
      canPublish: true,
      canSubscribe: false,
      canPublishData: false,
    });
  });

  it("gives a worker two tokens: hear the source room (hidden), publish to its output room", async () => {
    const { source, output } = await tokens.workerTokens(SESSION, "fr", "w1");
    const s = await read(source);
    const o = await read(output);
    expect(s.sub).toBe("worker-w1");
    expect(s.video).toMatchObject({ room: `ses-${SESSION}-src`, canSubscribe: true, canPublish: false, hidden: true });
    expect(o.sub).toBe("worker-w1");
    expect(o.video).toMatchObject({ room: `ses-${SESSION}-fr-0`, canPublish: true, canSubscribe: false });
  });

  it("makes every token expire after ten minutes", async () => {
    const claims = await read(await tokens.listenerToken(SESSION, "de", "abc"));
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(TOKEN_TTL_S);
    expect(TOKEN_TTL_S).toBe(600);
  });

  it("can't be read with a different secret", async () => {
    const token = await tokens.listenerToken(SESSION, "de", "abc");
    await expect(new TokenVerifier(config.apiKey, "another-secret-".repeat(3)).verify(token)).rejects.toThrow();
  });
});

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
const configured = Boolean(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET);

describe.skipIf(!configured)("tokens against LiveKit", () => {
  const config = { url: LIVEKIT_URL ?? "", apiKey: LIVEKIT_API_KEY ?? "", apiSecret: LIVEKIT_API_SECRET ?? "" };
  const httpUrl = config.url.replace(/^ws/, "http");

  // LiveKit's own check, as it runs when a browser or worker connects.
  const accepted = async (token: string) =>
    (await fetch(`${httpUrl}/rtc/validate?access_token=${encodeURIComponent(token)}`)).status;

  it("accepts the listener, host and worker tokens", async () => {
    const tokens = createTokenService(config);
    const { source, output } = await tokens.workerTokens(SESSION, "fr", "w1");
    expect(await accepted(await tokens.listenerToken(SESSION, "de", "abc"))).toBe(200);
    expect(await accepted(await tokens.hostToken(SESSION, "host-user-1"))).toBe(200);
    expect(await accepted(source)).toBe(200);
    expect(await accepted(output)).toBe(200);
  });

  it("refuses a token signed with the wrong secret", async () => {
    const forged = createTokenService({ ...config, apiSecret: "wrong-secret-".repeat(4) });
    expect(await accepted(await forged.listenerToken(SESSION, "de", "abc"))).toBe(401);
  });
});
