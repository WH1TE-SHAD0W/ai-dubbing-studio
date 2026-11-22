import { BlockList, isIP } from "node:net";
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

// The client's IP for our own rate limits, found the way Better Auth finds it:
// the right-most address in X-Forwarded-For (as written by withClientIp) that is
// not one of our trusted proxies. A client can only add entries on the left.
export function clientIp(c: Context, trustedProxies: string[] = []): string {
  const trusted = new BlockList();
  for (const entry of trustedProxies) {
    const [address, prefix] = entry.split("/");
    const family = address!.includes(":") ? "ipv6" : "ipv4";
    if (prefix === undefined) trusted.addAddress(address!, family);
    else trusted.addSubnet(address!, Number(prefix), family);
  }
  const chain = (withClientIp(c, trustedProxies.length > 0).headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const isTrusted = (ip: string) => isIP(ip) !== 0 && trusted.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
  return [...chain].reverse().find((ip) => !isTrusted(ip)) ?? chain[0] ?? "unknown";
}
