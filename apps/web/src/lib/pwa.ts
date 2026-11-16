import { useSyncExternalStore } from "react";
import { registerSW } from "virtual:pwa-register";

// A new service worker never reloads the page by itself: a reload in the middle of
// a live session would cut the audio (ADR-0010). The app shows a banner instead and
// the user reloads when it suits them.

let needRefresh = false;
let update: (() => Promise<void>) | undefined;
const listeners = new Set<() => void>();

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;
  update = registerSW({
    onNeedRefresh() {
      needRefresh = true;
      listeners.forEach((l) => l());
    },
  });
}

export function useUpdateAvailable(): { available: boolean; reload: () => void } {
  const available = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => needRefresh,
  );
  return { available, reload: () => void update?.() };
}
