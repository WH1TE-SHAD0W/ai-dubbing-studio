import {
  type HostTokenResponse,
  type JoinSessionResponse,
  type ListenerTokenResponse,
  type Session,
  createSessionRequestSchema,
  listenerTokenRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
} from "@ads/contracts";
import { HttpResponse, http } from "msw";

// A stand-in for the Hono API while it doesn't exist yet: `pnpm dev:mock` in the
// browser, and the tests in Node. Requests are validated with the same contract
// schemas the real API will use. State is kept in sessionStorage where available,
// so a page reload keeps you logged in.

type MockUser = { id: string; name: string; email: string; password: string };
type MockState = { users: MockUser[]; loggedIn: string | null; sessions: Session[] };

const STORAGE_KEY = "ads.mock";

// Seeded so the listener pages can be tried without creating a session first.
export const DEMO_LIVE_CODE = "DEMO42";
export const DEMO_DRAFT_CODE = "WAIT01";
export const DEMO_USER = { name: "Demo Host", email: "host@example.com", password: "demo password 123" };

function seed(): MockState {
  const now = new Date().toISOString();
  const base = { provider: "gemini" as const, createdAt: now, endedAt: null };
  return {
    users: [{ id: "u_demo", ...DEMO_USER }],
    loggedIn: null,
    sessions: [
      {
        ...base,
        id: "s_demo_live",
        joinCode: DEMO_LIVE_CODE,
        title: "Opening keynote",
        sourceLang: "en",
        languages: [
          { lang: "sk", peakListeners: 12 },
          { lang: "de", peakListeners: 7 },
        ],
        status: "live",
        startedAt: now,
      },
      {
        ...base,
        id: "s_demo_draft",
        joinCode: DEMO_DRAFT_CODE,
        title: "Afternoon panel",
        sourceLang: "de",
        languages: [{ lang: "en", peakListeners: 0 }],
        status: "draft",
        startedAt: null,
      },
    ],
  };
}

let memory: MockState | null = null;

function load(): MockState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as MockState;
  } catch {
    // No sessionStorage (Node) or blocked: keep state in memory.
  }
  memory ??= seed();
  return memory;
}

function save(state: MockState): void {
  memory = state;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // See load().
  }
}

export function resetMockState(): void {
  memory = seed();
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // See load().
  }
}

const id = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

function joinCode(taken: Set<string>): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I lookalikes
  for (;;) {
    const code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    if (!taken.has(code)) return code;
  }
}

function betterAuthUser(u: MockUser) {
  const now = new Date().toISOString();
  return { id: u.id, name: u.name, email: u.email, emailVerified: false, image: null, createdAt: now, updatedAt: now };
}

function betterAuthSession(u: MockUser) {
  const now = new Date();
  return {
    session: {
      id: "login_mock",
      token: "mock-login-token",
      userId: u.id,
      expiresAt: new Date(now.getTime() + 12 * 3600_000).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    user: betterAuthUser(u),
  };
}

const error = (status: number, message: string) => HttpResponse.json({ message }, { status });

function currentUser(state: MockState): MockUser | undefined {
  return state.users.find((u) => u.id === state.loggedIn);
}

export const handlers = [
  // Better Auth endpoints (mounted at /api/auth by the real API)
  http.post("*/api/auth/sign-up/email", async ({ request }) => {
    const parsed = registerRequestSchema.safeParse(await request.json());
    if (!parsed.success) return error(400, parsed.error.issues[0]?.message ?? "Invalid request.");
    const state = load();
    if (state.users.some((u) => u.email === parsed.data.email)) {
      return error(422, "This email is already registered. Log in instead.");
    }
    const user = { id: id("u"), ...parsed.data };
    save({ ...state, users: [...state.users, user], loggedIn: user.id });
    return HttpResponse.json({ token: "mock-login-token", user: betterAuthUser(user) });
  }),

  http.post("*/api/auth/sign-in/email", async ({ request }) => {
    const parsed = loginRequestSchema.safeParse(await request.json());
    const state = load();
    const user = parsed.success && state.users.find((u) => u.email === parsed.data.email && u.password === parsed.data.password);
    if (!user) return error(401, "Email or password is incorrect.");
    save({ ...state, loggedIn: user.id });
    return HttpResponse.json({ redirect: false, token: "mock-login-token", user: betterAuthUser(user) });
  }),

  http.post("*/api/auth/sign-out", () => {
    save({ ...load(), loggedIn: null });
    return HttpResponse.json({ success: true });
  }),

  http.get("*/api/auth/get-session", () => {
    const user = currentUser(load());
    return HttpResponse.json(user ? betterAuthSession(user) : null);
  }),

  // Sessions (host only)
  http.post("*/api/sessions", async ({ request }) => {
    const state = load();
    if (!currentUser(state)) return error(401, "Log in first.");
    const parsed = createSessionRequestSchema.safeParse(await request.json());
    if (!parsed.success) return error(400, parsed.error.issues[0]?.message ?? "Invalid request.");
    const live = new Set(state.sessions.filter((s) => s.status !== "ended").map((s) => s.joinCode));
    const session: Session = {
      id: id("s"),
      joinCode: joinCode(live),
      title: parsed.data.title,
      sourceLang: parsed.data.sourceLang,
      languages: parsed.data.targetLangs.map((lang) => ({ lang, peakListeners: 0 })),
      provider: parsed.data.provider,
      status: "draft",
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
    };
    save({ ...state, sessions: [...state.sessions, session] });
    return HttpResponse.json(session, { status: 201 });
  }),

  http.get("*/api/sessions/:id", ({ params }) => {
    const state = load();
    if (!currentUser(state)) return error(401, "Log in first.");
    const session = state.sessions.find((s) => s.id === params.id);
    return session ? HttpResponse.json(session) : error(404, "Session not found.");
  }),

  http.post("*/api/sessions/:id/:action", ({ params }) => {
    const state = load();
    if (!currentUser(state)) return error(401, "Log in first.");
    const session = state.sessions.find((s) => s.id === params.id);
    if (!session) return error(404, "Session not found.");
    if (params.action === "token") {
      // Like the real API: only for a live session. There is no LiveKit server
      // behind the mocks, so connecting with this fails.
      if (session.status !== "live") return error(409, "This session isn't live.");
      const body: HostTokenResponse = { serverUrl: "ws://localhost:7880", token: `mock-host-${session.id}` };
      return HttpResponse.json(body);
    }
    const now = new Date().toISOString();
    let next: Session;
    if (params.action === "start") {
      next = session.status === "draft" ? { ...session, status: "live", startedAt: now } : session;
    } else if (params.action === "end") {
      next = session.status === "ended" ? session : { ...session, status: "ended", endedAt: now };
    } else {
      return error(404, "Not found.");
    }
    save({ ...state, sessions: state.sessions.map((s) => (s.id === next.id ? next : s)) });
    return HttpResponse.json(next);
  }),

  // Listener (public)
  http.get("*/api/join/:code", ({ params }) => {
    const code = String(params.code).toUpperCase();
    const state = load();
    const session = state.sessions.find((s) => s.joinCode === code && s.status !== "ended");
    if (!session) return error(404, "No session uses this code.");
    const host = state.users.find((u) => u.id === state.loggedIn) ?? state.users[0];
    const body: JoinSessionResponse = {
      title: session.title,
      hostName: host?.name ?? "Host",
      sourceLang: session.sourceLang,
      languages: session.languages.map((l) => l.lang),
      status: session.status,
    };
    return HttpResponse.json(body);
  }),

  http.post("*/api/join/:code/token", async ({ params, request }) => {
    const parsed = listenerTokenRequestSchema.safeParse(await request.json());
    if (!parsed.success) return error(400, "Unknown language.");
    const session = load().sessions.find((s) => s.joinCode === String(params.code).toUpperCase() && s.status === "live");
    if (!session) return error(404, "This session isn't live.");
    // There is no LiveKit server behind the mocks, so connecting with this fails
    // and the page shows its connection error.
    const body: ListenerTokenResponse = { serverUrl: "ws://localhost:7880", token: `mock-${parsed.data.lang}` };
    return HttpResponse.json(body);
  }),
];
