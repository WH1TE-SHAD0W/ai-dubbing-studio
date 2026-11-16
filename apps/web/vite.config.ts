/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { msw } from "msw/vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Where the Hono API runs in local development. In production Hono serves this
// app itself, so the browser talks to one origin (ADR-0012).
const API_URL = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // `pnpm dev:mock` only: serves the MSW worker. Never part of a production build.
    mode === "mock" && msw({ mode: "worker-only" }),
    // Minimal PWA (ADR-0010): manifest and app-shell caching only. No offline mode,
    // and API calls and audio are never cached.
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["icon.svg"],
      manifest: {
        name: "AI Dubbing Studio",
        short_name: "Dubbing",
        description: "Hear a live speaker in your own language.",
        start_url: "/",
        display: "standalone",
        background_color: "#0f172a",
        theme_color: "#0f172a",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
    }),
  ],
  build: {
    // The lazily loaded LiveKit chunk is ~580 kB; the app entry stays well below.
    chunkSizeWarningLimit: 650,
  },
  server: {
    proxy: {
      "/api": { target: API_URL, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    alias: { "virtual:pwa-register": new URL("./test/pwa-register-stub.ts", import.meta.url).pathname },
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
  },
}));
