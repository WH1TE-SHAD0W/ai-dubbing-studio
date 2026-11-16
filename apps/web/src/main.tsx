import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerServiceWorker } from "./lib/pwa.ts";
import { makeRouter } from "./router.tsx";
import "./styles.css";

async function enableMocks(): Promise<void> {
  // `pnpm dev:mock` only. The condition is a build-time constant, so the mocks
  // are dropped from production builds.
  if (import.meta.env.DEV && import.meta.env.VITE_API_MOCK === "true") {
    const { worker } = await import("./mocks/browser.ts");
    await worker.start({ onUnhandledFrame: "bypass", quiet: true });
  }
}

const router = makeRouter();

void enableMocks().then(() => {
  registerServiceWorker();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
});
