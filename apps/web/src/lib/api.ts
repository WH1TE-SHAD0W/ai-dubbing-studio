import {
  type CreateSessionRequest,
  type JoinSessionResponse,
  type LanguageCode,
  type ListenerTokenResponse,
  type Session,
  joinSessionResponseSchema,
  listenerTokenResponseSchema,
  sessionSchema,
} from "@ads/contracts";
import type { z } from "zod";

// The PWA's calls to the Hono API. Every response is checked against the shared
// Zod schemas (ADR-0016), so a contract mismatch fails loudly here instead of deep
// in a component. Once the API exists this can move to Hono's typed `hc` client.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<S extends z.ZodType>(schema: S, path: string, init?: RequestInit): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(new URL(`/api${path}`, window.location.href), {
      ...init,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  if (!res.ok) {
    throw new ApiError(res.status, await errorMessage(res));
  }
  return schema.parse(await res.json());
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "message" in body && typeof body.message === "string") {
      return body.message;
    }
  } catch {
    // Not JSON: fall through to a generic message.
  }
  if (res.status === 404) return "Not found.";
  if (res.status === 429) return "Too many attempts. Wait a minute and try again.";
  return "Something went wrong. Try again.";
}

const post = (body?: unknown): RequestInit => ({ method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  // Host (needs the login cookie)
  createSession: (body: CreateSessionRequest): Promise<Session> => request(sessionSchema, "/sessions", post(body)),
  getSession: (id: string): Promise<Session> => request(sessionSchema, `/sessions/${encodeURIComponent(id)}`),
  startSession: (id: string): Promise<Session> => request(sessionSchema, `/sessions/${encodeURIComponent(id)}/start`, post()),
  endSession: (id: string): Promise<Session> => request(sessionSchema, `/sessions/${encodeURIComponent(id)}/end`, post()),

  // Listener (public)
  getJoin: (code: string): Promise<JoinSessionResponse> =>
    request(joinSessionResponseSchema, `/join/${encodeURIComponent(code)}`),
  getListenerToken: (code: string, lang: LanguageCode): Promise<ListenerTokenResponse> =>
    request(listenerTokenResponseSchema, `/join/${encodeURIComponent(code)}/token`, post({ lang })),
};
