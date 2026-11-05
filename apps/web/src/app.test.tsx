import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DEMO_DRAFT_CODE, DEMO_LIVE_CODE, DEMO_USER } from "./mocks/handlers.ts";
import { makeRouter } from "./router.tsx";

// Whole-app tests: real router and pages, with the MSW mock API from test/setup.ts.
function renderAt(path: string) {
  const router = makeRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(<RouterProvider router={router} />);
  return router;
}

async function logIn() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Email"), DEMO_USER.email);
  await user.type(screen.getByLabelText("Password"), DEMO_USER.password);
  await user.click(screen.getByRole("button", { name: "Log in" }));
  return user;
}

describe("routing", () => {
  it("sends / to the Join page", async () => {
    const router = renderAt("/");
    expect(await screen.findByRole("heading", { name: "Join a session" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/join");
  });

  it("turns a short link into the Listener page, upper-casing the code", async () => {
    const router = renderAt(`/j/${DEMO_LIVE_CODE.toLowerCase()}`);
    expect(await screen.findByRole("heading", { name: "Opening keynote" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/listen/${DEMO_LIVE_CODE}`);
  });

  it("sends a logged-out host from the Studio to Login", async () => {
    const router = renderAt("/studio");
    expect(await screen.findByRole("heading", { name: "Host login" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });
});

describe("Join page", () => {
  it("rejects a malformed code without leaving the page", async () => {
    const user = userEvent.setup();
    renderAt("/join");
    await user.type(await screen.findByLabelText("Session code"), "abc");
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the 6-character code.");
  });

  it("opens the session for a valid code", async () => {
    const user = userEvent.setup();
    renderAt("/join");
    await user.type(await screen.findByLabelText("Session code"), ` ${DEMO_LIVE_CODE.toLowerCase()} `);
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(await screen.findByRole("heading", { name: "Opening keynote" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start listening" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Slovak" })).toHaveAttribute("aria-pressed");
  });
});

describe("Listener page", () => {
  it("says when the host hasn't gone live yet", async () => {
    renderAt(`/listen/${DEMO_DRAFT_CODE}`);
    expect(await screen.findByRole("status")).toHaveTextContent("hasn't started yet");
  });

  it("says when no session uses the code", async () => {
    renderAt("/listen/ZZZZZZ");
    expect(await screen.findByRole("heading", { name: "Session not found" })).toBeInTheDocument();
  });
});

describe("Login", () => {
  it("shows the same message for any failed login", async () => {
    const user = userEvent.setup();
    renderAt("/login");
    await user.type(await screen.findByLabelText("Email"), "nobody@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong password");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Email or password is incorrect.");
  });
});

describe("Studio", () => {
  it("validates the form, creates a session and goes live", async () => {
    renderAt("/login");
    const user = await logIn();
    expect(await screen.findByRole("heading", { name: "Create a session" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create session" }));
    expect(await screen.findByText("Enter a session title.")).toBeInTheDocument();
    expect(screen.getByText("Pick at least one target language.")).toBeInTheDocument();
    expect(screen.getByText("The speaker must agree to voice replication.")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Session title/), "Team meeting");
    await user.click(screen.getByRole("button", { name: "Slovak" }));
    await user.click(screen.getByRole("checkbox", { name: /voice replicated/ }));
    await user.click(screen.getByRole("checkbox", { name: /AI-generated/ }));
    await user.click(screen.getByRole("button", { name: "Create session" }));

    expect(await screen.findByRole("heading", { name: "Team meeting" })).toBeInTheDocument();
    expect(screen.getByLabelText("Session code").textContent).toMatch(/^[A-Z0-9]{6}$/);
    expect(screen.getByText("Not live yet")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Go live" }));
    expect(await screen.findByRole("button", { name: "End session" })).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("doesn't offer the spoken language as a target", async () => {
    renderAt("/login");
    await logIn();
    await screen.findByRole("heading", { name: "Create a session" });
    const targets = screen.getByRole("group", { name: /Target languages/ });
    expect(targets).not.toHaveTextContent("English");
  });
});
