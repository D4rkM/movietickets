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
  preview: {
    host: true,
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
