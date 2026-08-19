import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The console is a pure projection of the read APIs (ADR-017); the dev proxy
// forwards /api → the api process so no CORS is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
