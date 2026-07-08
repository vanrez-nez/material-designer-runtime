import { vec2, vec3, mx_noise_float } from "three/tsl";
import type { MaterialNodeDef, MaterialValue } from "../../types";
import { pnoise2 } from "../../../tsl/tileable-noise";

type V = MaterialValue;

// Tileable Warp — offsets the uv tile by a PERIODIC noise vector, so a warped tileable chain stays
// seamless (`tileableNoise(uv + periodicWarp)` tiles because both the warp and the noise are periodic over
// [0,1]). Feeds a Tileable Noise's `coord`. In the LIVE backend it falls back to the old 3D `mx_noise`
// warp (no tiling needed there).
export const tileableWarpNode: MaterialNodeDef = {
  type: "tileable-warp",
  nodeClass: "vector",
  label: "Tileable Warp",
  inputs: [{ key: "coord", kind: "vector" }],
  outputs: [{ key: "coord", kind: "vector" }],
  params: [
    { key: "amount", label: "amount", type: "float", min: 0, max: 1, step: 0.01, default: 0.15 },
    { key: "scale", label: "scale", type: "int", min: 1, max: 64, step: 1, default: 4 },
  ],
  build(ctx) {
    const base = (ctx.inputs.coord ?? ctx.coord) as V;
    const amount = ctx.live("amount") as V;

    if (ctx.backend === "live") {
      const p = base.div(Math.max(1, Number(ctx.constant("scale") ?? 4))) as V;
      const wx = mx_noise_float(p.add(vec3(11.3, 0, 0)));
      const wy = mx_noise_float(p.add(vec3(0, 47.7, 0)));
      const wz = mx_noise_float(p.add(vec3(0, 0, 93.1)));
      return { coord: base.add(vec3(wx, wy, wz).mul(amount)) };
    }
    // offline: periodic warp over the uv tile. Period = scale (integer); decorrelate the two channels with
    // constant offsets (phase shifts that preserve periodicity).
    const P = Math.max(1, Math.round(Number(ctx.constant("scale") ?? 4)));
    const uv = vec2(base.x, base.y) as V;
    const rep = vec2(P, P);
    const wx = pnoise2(uv.mul(P), rep);
    const wy = pnoise2(uv.mul(P).add(vec2(5.2, 1.3)), rep);
    const warped = uv.add(vec2(wx, wy).mul(amount)) as V;
    return { coord: vec3(warped.x, warped.y, base.z) };
  },
};
