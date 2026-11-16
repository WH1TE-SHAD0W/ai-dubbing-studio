import { joinCodeSchema } from "@ads/contracts";
import { Outlet, createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { isLoggedIn } from "./lib/auth.ts";
import { JoinPage } from "./pages/JoinPage.tsx";
import { ListenerPage } from "./pages/ListenerPage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { RegisterPage } from "./pages/RegisterPage.tsx";
import { StudioPage } from "./pages/studio/StudioPage.tsx";

// The five pages from ADR-0014. Listener routes are public; Studio needs a host login.

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/join" });
  },
});

const registerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/register", component: RegisterPage });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage });
const joinRoute = createRoute({ getParentRoute: () => rootRoute, path: "/join", component: JoinPage });

// Short link from a QR code or slide: /j/abc123 → /listen/ABC123.
const joinLinkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/j/$code",
  beforeLoad: ({ params }) => {
    const code = joinCodeSchema.safeParse(params.code);
    throw code.success ? redirect({ to: "/listen/$code", params: { code: code.data } }) : redirect({ to: "/join" });
  },
});

const studioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio",
  validateSearch: z.object({ session: z.string().min(1).optional() }),
  beforeLoad: async () => {
    if (!(await isLoggedIn())) throw redirect({ to: "/login" });
  },
  component: StudioPage,
});

const listenRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/listen/$code",
  params: {
    parse: ({ code }) => ({ code: code.toUpperCase() }),
    stringify: ({ code }) => ({ code }),
  },
  component: ListenerPage,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  registerRoute,
  loginRoute,
  joinRoute,
  joinLinkRoute,
  studioRoute,
  listenRoute,
]);

export function makeRouter(options?: Partial<Parameters<typeof createRouter>[0]>) {
  return createRouter({ routeTree, defaultPreload: "intent", ...options });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
