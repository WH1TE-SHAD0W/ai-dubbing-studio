import { createMiddleware } from "hono/factory";
import type { Auth, Host, Login } from "./auth.ts";

export type HostEnv = { Variables: { host: Host; login: Login } };

// Host-only routes: answers 401 unless the request carries a valid login cookie.
// Each check is one lookup in `logins`, so a logout or an expired login takes
// effect at once (ADR-0003).
export function requireHost(auth: Auth) {
  return createMiddleware<HostEnv>(async (c, next) => {
    const found = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!found) return c.json({ message: "Log in first." }, 401);
    c.set("host", found.user);
    c.set("login", found.session);
    await next();
  });
}
