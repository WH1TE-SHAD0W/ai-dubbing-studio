import { createHash, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";

// The translator workers' calls (/internal): answers 401 unless the request
// carries `Authorization: Bearer <INTERNAL_API_TOKEN>`. Both sides are hashed
// first so the comparison takes the same time whatever the length.
export function requireInternalToken(token: string) {
  const expected = digest(token);
  return createMiddleware(async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (given === "" || !timingSafeEqual(digest(given), expected)) {
      return c.json({ message: "Unauthorized." }, 401);
    }
    await next();
  });
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
