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
  const headers = clientIpHeaders(c, trustForwarded);
  return headers ? new Request(c.req.raw, { headers }) : c.req.raw;
}

// The headers withClientIp would send, or undefined when there is no socket and
// they stay as they are. Headers only: copying the request itself fails once a
// body has been read (the feedback route's validator reads it first).
function clientIpHeaders(c: Context, trustForwarded: boolean): Headers | undefined {
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    // No socket (Hono's app.request() in tests): leave the headers as they are.
  }
  if (!peer) return undefined;

  const headers = new Headers(c.req.raw.headers);
  const forwarded = trustForwarded ? headers.get("x-forwarded-for") : null;
  headers.set("x-forwarded-for", forwarded ? `${forwarded}, ${peer}` : peer);
  return headers;
}

// The BlockList for a trusted-proxy list, built once per list (the list comes
// from the settings and doesn't change while the API runs).
const trustedLists = new Map<string, BlockList>();
function trustedList(trustedProxies: string[]): BlockList {
  const cacheKey = trustedProxies.join(",");
  let list = trustedLists.get(cacheKey);
  if (!list) {
    list = new BlockList();
    for (const entry of trustedProxies) {
      const [address, prefix] = entry.split("/");
      const family = address!.includes(":") ? "ipv6" : "ipv4";
      if (prefix === undefined) list.addAddress(address!, family);
      else list.addSubnet(address!, Number(prefix), family);
    }
    trustedLists.set(cacheKey, list);
  }
  return list;
}

// The client's IP for our own rate limits, found the way Better Auth finds it:
// the right-most address in X-Forwarded-For (as written by withClientIp) that is
// not one of our trusted proxies. A client can only add entries on the left.
export function clientIp(c: Context, trustedProxies: string[] = []): string {
  const trusted = trustedList(trustedProxies);
  const chain = ((clientIpHeaders(c, trustedProxies.length > 0) ?? c.req.raw.headers).get("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const isTrusted = (ip: string) => isIP(ip) !== 0 && trusted.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
  return [...chain].reverse().find((ip) => !isTrusted(ip)) ?? chain[0] ?? "unknown";
}
