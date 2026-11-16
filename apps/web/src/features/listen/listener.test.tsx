import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionState } from "livekit-client";
import { describe, expect, it, vi } from "vitest";
import { DEMO_LIVE_CODE } from "../../mocks/handlers.ts";
import { makeRouter } from "../../router.tsx";
import { statusText } from "./ListenerAudio.tsx";

// The listener page's playback controls and end state (YGP-106). LiveKit can't
// run in jsdom, so the room is a stand-in that shows what it was given and can
// end the session the way LiveKit does when the API deletes the room.
vi.mock("./ListenerAudio.tsx", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ListenerAudio.tsx")>();
  return {
    ...real,
    ListenerAudio: ({ volume, muted, onEnded }: { volume: number; muted: boolean; onEnded: () => void }) => (
      <div>
        <p data-testid="playback">
          volume {volume}, {muted ? "muted" : "not muted"}
        </p>
        <button type="button" onClick={onEnded}>
          Room deleted
        </button>
      </div>
    ),
  };
});

describe("the listener's status line", () => {
  it("says Connecting… until the first connection, not Disconnected", () => {
    expect(statusText(ConnectionState.Disconnected, false)).toBe("Connecting…");
    expect(statusText(ConnectionState.Connecting, false)).toBe("Connecting…");
    expect(statusText(ConnectionState.Connected, true)).toBe("Listening");
  });

  it("says when the connection dropped after it worked", () => {
    expect(statusText(ConnectionState.Reconnecting, true)).toBe("Connection lost, reconnecting…");
    expect(statusText(ConnectionState.SignalReconnecting, true)).toBe("Connection lost, reconnecting…");
    expect(statusText(ConnectionState.Disconnected, true)).toBe("Disconnected");
  });
});

describe("listening to a live session", () => {
  async function startListening() {
    const user = userEvent.setup();
    const router = makeRouter({ history: createMemoryHistory({ initialEntries: [`/listen/${DEMO_LIVE_CODE}`] }) });
    render(<RouterProvider router={router} />);
    await user.click(await screen.findByRole("button", { name: "Start listening" }));
    await screen.findByTestId("playback");
    return user;
  }

  it("mutes and keeps the volume and mute when the language changes", async () => {
    const user = await startListening();
    expect(screen.getByTestId("playback")).toHaveTextContent("volume 1, not muted");

    await user.click(screen.getByRole("button", { name: "Mute" }));
    expect(screen.getByTestId("playback")).toHaveTextContent("muted");
    expect(screen.getByRole("button", { name: "Unmute" })).toHaveAttribute("aria-pressed", "true");

    // Another language is another room: the stand-in is created again.
    const languages = within(screen.getByRole("group", { name: "Your language" })).getAllByRole("button");
    await user.click(languages.find((b) => b.getAttribute("aria-pressed") === "false")!);
    expect(await screen.findByTestId("playback")).toHaveTextContent("volume 1, muted");
  });

  it("says the session has ended when the host ends it", async () => {
    const user = await startListening();
    await user.click(screen.getByRole("button", { name: "Room deleted" }));
    expect(await screen.findByRole("status")).toHaveTextContent("This session has ended. Thanks for listening.");
    expect(screen.queryByRole("button", { name: "Stop listening" })).not.toBeInTheDocument();
  });
});
