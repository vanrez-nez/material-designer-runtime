import type { MaterialBakeService } from "./bake-service";
import { MaterialGraphSession } from "../document";
import type { NodeRegistry } from "./registry";
import type { MaterialGraphDocument, PbrSocket } from "./types";

// Automated tiling test for the Tileable Noise node (dev diagnostic). For each selectable noise type it bakes
// the `field` output to a tile and quantitatively checks the offline bake is SEAMLESS — no human eyeballing.
//
// How the seam metric works: the bake samples uv ∈ [0,1] at N pixels, and the texture wraps, so the pixel
// just past the right edge (N-1) is the left edge (0) of the next tile. For a tiling field those two columns
// are 1/N apart in wrapped space → their difference should be a NORMAL interior gradient. A seam makes that
// wrap difference spike. So `ratio = wrapEdgeDiff / interiorGradient`: ~1 = seamless, ≫1 = a seam. Computed
// for both the left↔right (H) and top↔bottom (V) wraps.

export interface SeamMetrics {
  type: string;
  ratioH: number; // left↔right wrap diff / interior horizontal gradient
  ratioV: number; // top↔bottom wrap diff / interior vertical gradient
  wrapH: number;
  wrapV: number;
  interiorH: number;
  interiorV: number;
  pass: boolean;
}

export interface TilingTestOptions {
  size?: number; // tile resolution (multiple of 64 for aligned WebGPU readback). Default 256.
  threshold?: number; // max wrap/interior ratio to count as seamless. Default 3.
  channel?: PbrSocket; // which baked channel to read. Default baseColor (the field as grayscale).
  types?: string[]; // override the type list (defaults to the node's live noiseType options).
  onTile?: (type: string, img: ImageData) => void | Promise<void>; // hook to e.g. save a composite PNG.
}

// One noise type → a minimal graph: Tileable Noise (field) → Material (baseColor) → Material Output.
// `params` is the resolved tileable-noise param set — an algorithm (`{ noiseType }`) or a Perlin preset
// (`{ noiseType: "perlin-fbm", preset }`); the caller resolves which (see runTilingTest).
function noiseDoc(params: Record<string, unknown>): MaterialGraphDocument {
  return {
    version: 4,
    nodes: [
      {
        id: "n",
        type: "tileable-noise",
        params: { scale: 5, octaves: 4, gain: 0.5, ...params },
        position: { x: 0, y: 0 },
        enabled: true,
      },
      { id: "pr", type: "shader-material", params: { materialType: "physical" }, position: { x: 300, y: 0 }, enabled: true },
      { id: "out", type: "material-output", params: {}, position: { x: 600, y: 0 }, enabled: true },
    ],
    edges: [
      { fromNode: "n", fromOutput: "field", toNode: "pr", toInput: "baseColor" },
      { fromNode: "pr", fromOutput: "bsdf", toNode: "out", toInput: "surface" },
    ],
  };
}

// Wrap-edge vs interior-gradient ratios from a baked tile (uses the red channel — the field is grayscale).
function seamMetrics(img: ImageData, n: number): Omit<SeamMetrics, "type" | "pass"> {
  const at = (x: number, y: number): number => img.data[(y * n + x) * 4];
  let wrapH = 0;
  let interiorH = 0;
  for (let y = 0; y < n; y++) {
    wrapH += Math.abs(at(n - 1, y) - at(0, y));
    for (let x = 1; x < n; x++) interiorH += Math.abs(at(x, y) - at(x - 1, y));
  }
  let wrapV = 0;
  let interiorV = 0;
  for (let x = 0; x < n; x++) {
    wrapV += Math.abs(at(x, n - 1) - at(x, 0));
    for (let y = 1; y < n; y++) interiorV += Math.abs(at(x, y) - at(x, y - 1));
  }
  wrapH /= n;
  wrapV /= n;
  interiorH /= n * (n - 1);
  interiorV /= n * (n - 1);
  return {
    wrapH,
    wrapV,
    interiorH,
    interiorV,
    ratioH: wrapH / Math.max(interiorH, 1e-3),
    ratioV: wrapV / Math.max(interiorV, 1e-3),
  };
}

// Run the test across every Tileable Noise type. Bakes each on a THROWAWAY graph through the service — it
// never touches a live on-screen material, so no object gets clobbered. Returns one SeamMetrics row per type.
export async function runTilingTest(
  service: MaterialBakeService,
  registry: NodeRegistry,
  options: TilingTestOptions = {},
): Promise<SeamMetrics[]> {
  const size = options.size ?? 256;
  const threshold = options.threshold ?? 3;
  const channel = options.channel ?? "baseColor";
  // Default coverage = every algorithm, plus each Perlin preset (curl/paper/wool/stone/erosion — the
  // compositions live behind `preset` now, so they must be exercised explicitly). A preset `type` compiles
  // as perlin-fbm + that preset; anything else is an algorithm noiseType.
  const nodeParams = registry.get("tileable-noise").params;
  const algorithms = (nodeParams.find((p) => p.key === "noiseType")?.options as string[] | undefined) ?? [];
  const presets = ((nodeParams.find((p) => p.key === "preset")?.options as string[] | undefined) ?? []).filter(
    (p) => p !== "none",
  );
  const presetSet = new Set(presets);
  const types = options.types ?? [...algorithms, ...presets];

  const results: SeamMetrics[] = [];
  for (const type of types) {
    const params = presetSet.has(type) ? { noiseType: "perlin-fbm", preset: type } : { noiseType: type };
    const graph = new MaterialGraphSession(noiseDoc(params), registry);
    const img = await service.readImage(graph, channel, size);
    if (!img) {
      results.push({
        type,
        ratioH: NaN,
        ratioV: NaN,
        wrapH: NaN,
        wrapV: NaN,
        interiorH: NaN,
        interiorV: NaN,
        pass: false,
      });
      continue;
    }
    if (options.onTile) await options.onTile(type, img);
    const m = seamMetrics(img, size);
    results.push({ type, ...m, pass: m.ratioH <= threshold && m.ratioV <= threshold });
  }
  return results;
}
