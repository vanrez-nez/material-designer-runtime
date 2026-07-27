import { defineConfig } from "vite";

export default defineConfig({
  // The bake cache's worker is imported `?worker&inline`, so it is base64-inlined into dist/index.js rather
  // than emitted as a second file — consumers get one self-contained module with no worker URL to resolve.
  // ES format so the worker can use plain imports (it shares codec + idb-core with the main thread).
  worker: {
    format: "es",
  },
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
