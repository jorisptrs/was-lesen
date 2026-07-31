import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: Vite serves the client on :5173 and proxies /api to the Express server on :3000.
// Prod: `vite build` emits ./dist, which the Express server serves directly (one process).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@sb/shared": resolve(import.meta.dirname, "../shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
  build: { outDir: "dist" },
});
