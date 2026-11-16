import type { Session } from "@ads/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const session = {
  id: "s1",
  title: "Demo",
  joinCode: "DEMO42",
  status: "draft",
  sourceLang: "en",
  languages: [{ lang: "de", peakListeners: 7 }],
} as unknown as Session;

async function renderWith(peakListeners: boolean) {
  vi.resetModules();
  vi.doMock("../../lib/flags.ts", () => ({ isEnabled: (f: string) => f === "peakListeners" && peakListeners }));
  vi.doMock("../../features/mic/MicPicker.tsx", () => ({ MicPicker: () => null }));
  const { ControlRoom } = await import("./ControlRoom.tsx");
  render(<ControlRoom session={session} onChange={() => {}} onNew={() => {}} />);
}

describe("peakListeners flag", () => {
  it("hides the peak listener count when off", async () => {
    await renderWith(false);
    expect(screen.queryByText(/peak 7 listeners/)).not.toBeInTheDocument();
  });

  it("shows it when on", async () => {
    await renderWith(true);
    expect(screen.getByText("peak 7 listeners")).toBeInTheDocument();
  });
});
