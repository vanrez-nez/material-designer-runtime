import type { MaterialNodeDef, MaterialValue } from "../../types";
import { scatterPattern } from "../../../tsl/scatter";

type V = MaterialValue;

// Scatter — DISTRIBUTION ONLY (Substance "Tile Sampler"-style point sampler). Jittered grid with per-cell
// random position / size / rotation and a per-cell drop-out (`amount`) → sparse, non-uniform placement. It
// owns no silhouette: it outputs the local `coord` of the nearest kept stamp (unit-footprint frame), the
// per-stamp `value` (→ colour / shape seed / variation), and `size`. Feed `coord` into a Shape node (or any
// coord-driven node) to draw something; stack a few at different density/radius and height-blend (max) for a
// natural size range. Seamless in the offline bake.
export const scatterNode: MaterialNodeDef = {
  type: "scatter",
  nodeClass: "texture",
  label: "Scatter",
  inputs: [{ key: "coord", kind: "vector" }],
  outputs: [
    { key: "coord", label: "Coord", kind: "vector" },
    { key: "value", label: "Value", kind: "float" },
    { key: "size", label: "Size", kind: "float" },
  ],
  params: [
    { key: "density", label: "density", type: "int", min: 1, max: 48, step: 1, default: 10 },
    { key: "amount", label: "amount", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: "radius", label: "radius", type: "float", min: 0.05, max: 1, step: 0.01, default: 0.4 },
    { key: "sizeRandom", label: "size rand", type: "float", min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: "posRandom", label: "pos rand", type: "float", min: 0, max: 1, step: 0.01, default: 0.85 },
    { key: "rotRandom", label: "rot rand", type: "float", min: 0, max: 1, step: 0.01, default: 1 },
  ],
  build(ctx) {
    const coord = (ctx.inputs.coord ?? ctx.coord) as V;
    const rawDensity = Math.round(Number(ctx.constant("density") ?? 10));
    const density = Number.isFinite(rawDensity) ? Math.max(1, rawDensity) : 10;
    const { coord: local, value, size } = scatterPattern(coord, density, {
      amount: ctx.live("amount") as V,
      radius: ctx.live("radius") as V,
      sizeRandom: ctx.live("sizeRandom") as V,
      posRandom: ctx.live("posRandom") as V,
      rotRandom: ctx.live("rotRandom") as V,
    });
    return { coord: local, value, size };
  },
};
