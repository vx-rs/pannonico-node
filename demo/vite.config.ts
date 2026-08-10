import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    origin: "http://127.0.0.1:5173",
    port: 5173,
    strictPort: true,
  },
  build: {
    manifest: true,
    outDir: ".pannonico/vite",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        app: "src/app.ts",
      },
    },
  },
});
