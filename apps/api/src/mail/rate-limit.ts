import type { Redis } from "ioredis";

// A fixed-window counter per key, kept in Redis so every API copy shares it
// (an in-memory map would give each pod its own allowance).
export type RateLimiter = {
  // True when this call is within the allowance, false when it is over it.
  allow(key: string): Promise<boolean>;
};

// One Lua step, so the counter and its expiry can't be split by a crash: a key
// without an expiry (TTL -1) gets one on the next hit, too.
const INCR_WITH_EXPIRY = `
local count = redis.call("INCR", KEYS[1])
if count == 1 or redis.call("TTL", KEYS[1]) == -1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return count
`;

export function createRateLimiter(redis: Pick<Redis, "eval">, opts: { prefix: string; limit: number; windowSec: number }): RateLimiter {
  return {
    async allow(key) {
      const k = `${opts.prefix}:${key}`;
      // The first hit starts the window.
      const count = Number(await redis.eval(INCR_WITH_EXPIRY, 1, k, opts.windowSec));
      return count <= opts.limit;
    },
  };
}
