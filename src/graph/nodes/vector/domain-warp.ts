import { mx_noise_float, vec3 } from "three/tsl";
import type { MaterialNodeDef } from "../../types";

// Offsets the coordinate domain by vector noise — the generic warp operator (replaces warp.ts). Feeds
// any generator's `coord` input; unconnected, it warps the global domain.
export const domainWarpNode: MaterialNodeDef = {
  type: "domain-warp",
  nodeClass: "vector",
  label: "Domain Warp",
  inputs: [{ key: "coord", kind: "vector" }],
  outputs: [{ key: "coord", kind: "vector" }],
  params: [
    { key: "amount", label: "amount", type: "float", min: 0, max: 2, step: 0.01, default: 0.3 },
    { key: "scale", label: "scale", type: "float", min: 0.1, max: 8, step: 0.05, default: 1 },
  ],
  build(ctx) {
    const base = ctx.inputs.coord ?? ctx.coord;
    const p = base.div(ctx.live("scale"));
    // Decorrelated noise per axis (distinct lattice offsets keep the warp vector independent).
    const wx = mx_noise_float(p.add(vec3(11.3, 0, 0)));
    const wy = mx_noise_float(p.add(vec3(0, 47.7, 0)));
    const wz = mx_noise_float(p.add(vec3(0, 0, 93.1)));
    return { coord: base.add(vec3(wx, wy, wz).mul(ctx.live("amount"))) };
  },
};
