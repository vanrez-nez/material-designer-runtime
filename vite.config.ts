import { defineConfig, type Plugin } from "vite";

function assertProductionEntryExcludesProfiling(): Plugin {
  const forbiddenModuleFragments = [
    "/src/profiling/",
    "/src/graph/node-profiler.ts",
    "/src/graph/shader-cache-bust.ts",
  ];

  return {
    name: "assert-production-entry-excludes-profiling",
    generateBundle(_options, bundle) {
      const visited = new Set<string>();
      const visit = (fileName: string): void => {
        if (visited.has(fileName)) return;
        visited.add(fileName);
        const output = bundle[fileName];
        if (!output || output.type !== "chunk") return;
        const leaked = output.moduleIds.find((moduleId) =>
          forbiddenModuleFragments.some((fragment) => moduleId.replaceAll("\\", "/").includes(fragment)),
        );
        if (leaked) {
          this.error(`Production runtime entry imports profiling module: ${leaked}`);
        }
        for (const dependency of [...output.imports, ...output.dynamicImports]) visit(dependency);
      };

      const productionEntry = Object.values(bundle).find(
        (output) => output.type === "chunk" && output.isEntry && output.name === "index",
      );
      if (!productionEntry || productionEntry.type !== "chunk") {
        this.error("Could not find the production runtime entry chunk.");
      }
      visit(productionEntry.fileName);
    },
  };
}

export default defineConfig({
  plugins: [assertProductionEntryExcludesProfiling()],
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
        profiling: "src/profiling/index.ts",
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
