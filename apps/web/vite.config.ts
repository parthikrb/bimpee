/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.BIMPEE_API ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/parties": { target: api, changeOrigin: true, ws: true },
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/three") || id.includes("node_modules/postprocessing")) return "three";
          if (id.includes("node_modules/tone")) return "tone";
          return undefined;
        },
      },
    },
  },
  test: { environment: "node" },
});
