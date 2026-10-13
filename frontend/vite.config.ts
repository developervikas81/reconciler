import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        timeout: 300000,
        proxyTimeout: 300000,
      },
      "/receipts": {
        target: "http://127.0.0.1:3001",
      },
    },
  },
});
