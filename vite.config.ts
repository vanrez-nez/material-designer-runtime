import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: ["three", "three/tsl", "three/webgpu"],
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name]-[hash].js",
      },
    },
  },
});
