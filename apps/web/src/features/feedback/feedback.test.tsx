import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../test/setup.ts";

// The feedback form on the listener's ended state (YGP-120). The flag is
// switched per test; the room stand-in ends the session like LiveKit does.
let flagOn = true;
vi.mock("../../lib/flags.ts", () => ({ isEnabled: (f: string) => f === "listenerFeedback" && flagOn }));
vi.mock("../listen/ListenerAudio.tsx", async (importOriginal) => {
  const real = await importOriginal<typeof import("../listen/ListenerAudio.tsx")>();
  return {
    ...real,
    ListenerAudio: ({ onEnded }: { onEnded: () => void }) => (
      <button type="button" onClick={onEnded}>
        Room deleted
      </button>
    ),
  };
});

async function endSession() {
  const { DEMO_LIVE_CODE } = await import("../../mocks/handlers.ts");
  const { makeRouter } = await import("../../router.tsx");
  const user = userEvent.setup();
  render(<RouterProvider router={makeRouter({ history: createMemoryHistory({ initialEntries: [`/listen/${DEMO_LIVE_CODE}`] }) })} />);
  await user.click(await screen.findByRole("button", { name: "Start listening" }));
  await user.click(await screen.findByRole("button", { name: "Room deleted" }));
  return user;
}

describe("feedback form", () => {
  beforeEach(() => {
    flagOn = true;
  });

  it("is not shown while listening", async () => {
    const { DEMO_LIVE_CODE } = await import("../../mocks/handlers.ts");
    const { makeRouter } = await import("../../router.tsx");
    render(<RouterProvider router={makeRouter({ history: createMemoryHistory({ initialEntries: [`/listen/${DEMO_LIVE_CODE}`] }) })} />);
    await screen.findByRole("button", { name: "Start listening" });
    expect(screen.queryByRole("heading", { name: "How was it?" })).not.toBeInTheDocument();
  });

  it("is hidden when the flag is off", async () => {
    flagOn = false;
    await endSession();
    expect(await screen.findByText("This session has ended. Thanks for listening.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "How was it?" })).not.toBeInTheDocument();
  });

  it("sends the feedback after the session ended and says thanks", async () => {
    let body: unknown;
    server.use(
      http.post("*/api/feedback", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = await endSession();
    await user.click(await screen.findByRole("button", { name: "4 out of 5" }));
    await user.type(screen.getByLabelText("Your feedback"), "Clear audio");
    await user.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(await screen.findByText("Thank you, your feedback was sent.")).toBeInTheDocument();
    expect(body).toEqual({ message: "Clear audio", rating: 4 });
  });

  it("asks for a message and keeps the text when the API fails", async () => {
    server.use(http.post("*/api/feedback", () => HttpResponse.json({ message: "Too many attempts, try again in an hour." }, { status: 429 })));
    const user = await endSession();
    await user.click(await screen.findByRole("button", { name: "Send feedback" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Write a message");

    await user.type(screen.getByLabelText("Your feedback"), "Great");
    await user.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(await screen.findByText("Too many attempts, try again in an hour.")).toBeInTheDocument();
    expect(screen.getByLabelText("Your feedback")).toHaveValue("Great");
  });
});
