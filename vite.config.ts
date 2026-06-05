import { fileURLToPath, URL } from "url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

const zarrPort = process.env.ZARR_PORT ?? "8080";
const parqPort = process.env.PARQ_PORT ?? "9091";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue(), glsl()],
  server: {
    proxy: {
      "/localdata": {
        target: `http://localhost:${zarrPort}`,
        rewrite: (path) => path.replace(/^\/localdata/, ""),
      },
      "/parqproxy": {
        target: `http://localhost:${parqPort}`,
        rewrite: (path) => path.replace(/^\/parqproxy/, ""),
      },
    },
  },
  build: {
    sourcemap: true,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: "modern-compiler",
      },
    },
  },
  base: "./",
});
