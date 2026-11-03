import { createAuthClient } from "better-auth/react";

// Better Auth client for host accounts (ADR-0003, ADR-0015). The server mounts
// Better Auth at /api/auth on the same origin, so the login cookie is sent
// automatically. Listeners never use this.
export const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? "http://localhost" : window.location.origin,
  basePath: "/api/auth",
  // Look up the global fetch on every call rather than once at import, so the MSW
  // mocks (dev and tests) can intercept it.
  fetchOptions: { customFetchImpl: (input, init) => fetch(input, init) },
});

export const { useSession } = authClient;

// Used by the Studio route guard: true when a host is logged in.
export async function isLoggedIn(): Promise<boolean> {
  try {
    const { data } = await authClient.getSession();
    return Boolean(data?.user);
  } catch {
    return false;
  }
}
