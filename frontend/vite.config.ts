import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    proxy: {
      // The backend listens on 3001 — `PORT=3001` in backend/.env.example,
      // `ports: 3001:3001` in docker-compose.yml, and the default in
      // backend/src/index.ts. This said 8000, which no part of this project
      // has ever used, so every `/api` call from `npm run dev` was a proxy
      // error. It fails as an empty response rather than as a 404, which reads
      // as a broken backend rather than as a misdirected proxy.
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
