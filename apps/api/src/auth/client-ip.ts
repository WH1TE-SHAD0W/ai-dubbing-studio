import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

// Better Auth finds the client IP (for rate limits) only in request headers, and it
// can't see the TCP connection. So before handing a request to Better Auth, the API
// writes X-Forwarded-For itself, the way a reverse proxy would:
//
// - no trusted proxies: the header becomes just the socket address, so whatever
//   the client sent is ignored;
// - trusted proxies configured: the socket address is appended to the chain the
//   proxy sent, and Better Auth walks it from the right, skipping trusted hops.
//   A client that connects directly still ends up as the right-most entry.
export function withClientIp(c: Context, trustForwarded: boolean): Request {
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    // No socket (Hono's app.request() in tests): leave the headers as they are.
  }
  if (!peer) return c.req.raw;

  const headers = new Headers(c.req.raw.headers);
  const forwarded = trustForwarded ? headers.get("x-forwarded-for") : null;
  headers.set("x-forwarded-for", forwarded ? `${forwarded}, ${peer}` : peer);
  return new Request(c.req.raw, { headers });
}
