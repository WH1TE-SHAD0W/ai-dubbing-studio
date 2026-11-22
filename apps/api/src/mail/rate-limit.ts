import type { Redis } from "ioredis";

// A fixed-window counter per key, kept in Redis so every API copy shares it
// (an in-memory map would give each pod its own allowance).
export type RateLimiter = {
  // True when this call is within the allowance, false when it is over it.
  allow(key: string): Promise<boolean>;
};

export function createRateLimiter(redis: Pick<Redis, "incr" | "expire">, opts: { prefix: string; limit: number; windowSec: number }): RateLimiter {
  return {
    async allow(key) {
      const k = `${opts.prefix}:${key}`;
      const count = await redis.incr(k);
      // The first hit starts the window.
      if (count === 1) await redis.expire(k, opts.windowSec);
      return count <= opts.limit;
    },
  };
}
