import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

// Serves the built PWA (ADR-0012), so the app and the API share one origin.
//
// Cache headers (ADR-0012 follow-up): Vite's hashed files under /assets never
// change, so browsers keep them for a year. Everything else (the entry page, the
// service worker, the manifest) is revalidated on every load, so a deploy is
// picked up at once.
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

// A path that names a file (has an extension) is never answered with the entry
// page: a missing script must be a 404, not HTML.
const LOOKS_LIKE_FILE = /\.[a-z0-9]+$/i;

export function pwa(root: string) {
  return (
    new Hono()
      // Set once the file is found: serveStatic builds its own response.
      .use("*", async (c, next) => {
        await next();
        if (c.res.ok) c.res.headers.set("Cache-Control", c.req.path.startsWith("/assets/") ? IMMUTABLE : REVALIDATE);
      })
      .use("*", serveStatic({ root }))
      .get("*", async (c, next) => {
        if (LOOKS_LIKE_FILE.test(c.req.path)) return c.notFound();
        // Client-side routes (/studio, /listen/ABC123, …) all load the entry page.
        return (await serveStatic({ root, path: "index.html" })(c, next)) ?? c.notFound();
      })
  );
}
