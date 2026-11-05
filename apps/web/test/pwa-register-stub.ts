// Tests run without the PWA plugin, so `virtual:pwa-register` doesn't exist there.
export function registerSW(): () => Promise<void> {
  return async () => {};
}
