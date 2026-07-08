import type { MaterialNodeDef } from "../../types";
import { blenderFbm } from "../../../tsl/blender-noise";

// Noise Texture (Blender ShaderNodeTexNoise, Fac output) — a faithful port of Blender's Perlin fBm
// (plan L4 / decision 2; math in tsl/blender-noise.ts). Replaces the earlier MaterialX approximation so
// outputs match Blender. `octaves` (= Blender's Detail) drives a JS-side loop unroll, so it's read raw
// (build-time constant), not a dynamic uniform — the WebGPU loop caveat. scale/gain(=roughness)/
// lacunarity stay live uniforms.
export const fbmNode: MaterialNodeDef = {
  type: "fbm",
  nodeClass: "texture",
  label: "Noise (FBM)",
  // Optional `coord` input lets a Domain Warp (or any vector source) drive the domain; unconnected, it
  // falls back to the global coordinate (positionWorld live / uv-slice baked).
  inputs: [{ key: "coord", kind: "vector" }],
  outputs: [{ key: "field", kind: "float" }],
  params: [
    { key: "scale", label: "scale", type: "float", min: 0.1, max: 8, step: 0.05, default: 1.2 },
    { key: "octaves", label: "detail", type: "int", min: 0, max: 15, step: 1, default: 4 },
    { key: "lacunarity", label: "lacunarity", type: "float", min: 1.5, max: 3, step: 0.05, default: 2 },
    { key: "gain", label: "roughness", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 },
  ],
  build(ctx) {
    // Blender multiplies the domain by Scale (larger Scale ⇒ finer features).
    const p = (ctx.inputs.coord ?? ctx.coord).mul(ctx.live("scale"));
    const octaves = (ctx.constant("octaves") as number) ?? 4;
    const field = blenderFbm(p, octaves, ctx.live("gain"), ctx.live("lacunarity"));
    return { field };
  },
};
