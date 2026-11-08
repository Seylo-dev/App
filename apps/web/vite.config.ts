// The web app is a static SPA that the panel serves from apps/web/dist.
// In development, Vite serves it on :5173 and proxies the API and both
// WebSockets to a panel on :3000 (`bun run dev` in apps/panel).

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { precompress } from "./build/precompress";

const panel = process.env.PANEL_URL ?? "http://localhost:3000";

export default defineConfig({
  // The router plugin reads tsr.config.json and must run before React's.
  // Each route loads its own chunk, so Monaco and xterm only download on the screens that use them.
  // precompress writes .br and .gz copies the panel serves to browsers that accept them.
  plugins: [tanstackRouter({ autoCodeSplitting: true }), react(), tailwindcss(), precompress()],
  server: {
    proxy: {
      "/api": { target: panel, ws: true, changeOrigin: false },
    },
  },
  build: {
    sourcemap: true,
  },
});
