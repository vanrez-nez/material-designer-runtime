import { vec2, floor, float } from "three/tsl";
import type { MaterialNodeDef, MaterialValue } from "../../types";
import { blue12, hilbertBlue12, ign12, goldenIgn12, scratches12 } from "../../../tsl/noise/screen";

type V = MaterialValue;

const SCREEN_TYPES = ["blue", "hilbert-blue", "ign", "golden-ign", "scratches"];

// Screen Noise — the @lumiey pixel/screen-space dither family (blue noise, Hilbert blue, interleaved-gradient
// noise, golden IGN, scratches). These are NOT tileable and ARE resolution-dependent by nature: they hash the
// integer PIXEL index (uv × resolution) or use screen-space derivatives (scratches → fwidth), so a baked tile
// won't match on-surface pixel density and won't repeat seamlessly. Intended as a dither / detail / scratch
// MASK to blend with other channels — not as a standalone tiling texture. (The seamless surface noises live
// on the Tileable Noise node.)
export const screenNoiseNode: MaterialNodeDef = {
  type: "screen-noise",
  nodeClass: "texture",
  label: "Screen Noise",
  inputs: [{ key: "coord", kind: "vector" }],
  outputs: [{ key: "field", kind: "float" }],
  params: [
    { key: "noiseType", label: "type", type: "select", options: SCREEN_TYPES, default: "blue" },
    { key: "resolution", label: "resolution", type: "float", min: 16, max: 2048, step: 1, default: 512 },
  ],
  build(ctx) {
    const coord = (ctx.inputs.coord ?? ctx.coord) as V;
    const uv2 = vec2(coord.x, coord.y) as V;
    const noiseType = (ctx.constant("noiseType") as string) ?? "blue";

    // Scratches use their own coarse cell grid and never read `resolution` — wire the live pixel-density
    // uniform ONLY in the pixel-hash branches below (conditional wiring: reading it here would falsely mark
    // it live in a path that ignores it).
    if (noiseType === "scratches") {
      // Scratches read a coarser cell grid (their own density); fixed thinness so they're visible in the
      // bake (the @lumiey fwidth-based thinness collapses to hairline at bake resolution).
      return { field: scratches12(uv2.mul(5), float(3)) };
    }

    const px = uv2.mul(ctx.live("resolution")) as V; // pixel-space coordinate
    switch (noiseType) {
      case "hilbert-blue":
        return { field: hilbertBlue12(floor(px)) };
      case "ign":
        return { field: ign12(floor(px)) };
      case "golden-ign":
        return { field: goldenIgn12(floor(px)) };
      case "blue":
      default:
        return { field: blue12(floor(px)) };
    }
  },
};
