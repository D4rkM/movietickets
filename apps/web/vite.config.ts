import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Same port as `vite`'s own dev-server default, so CORS_ORIGIN on the API
  // (defaults to http://localhost:5173) matches `vite preview` too, not just
  // `vite dev` — matters for the containerized `make up-full` profile, where
  // `vite preview` is the production-style static server. `host: true` binds
  // 0.0.0.0 so it's reachable from outside the container.
  // Lets an ngrok tunnel (any random free-tier subdomain) reach the dev server
  // for manually testing Mercado Pago's back_urls redirect, which requires
  // https. Vite blocks unrecognized Host headers by default (DNS-rebinding
  // protection) — local-only testing convenience, not meant for production.
  // Set on both `server` (`vite dev`, used by `pnpm dev:web`) and `preview`
  // (`vite preview`, used by the containerized `make up-full` profile) — each
  // is a separate Vite config block with its own allowedHosts.
  preview: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: [".ngrok-free.app"],
  },
  server: {
    allowedHosts: [".ngrok-free.app"],
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Playwright specs live under e2e/ and run via `pnpm test:e2e`, not Vitest.
    exclude: ["e2e/**", "node_modules/**"],
  },
});
