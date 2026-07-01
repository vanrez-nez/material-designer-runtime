import { vec2, vec3, float, int, floor, clamp, length, min, pow, smoothstep } from "three/tsl";
import type { MaterialValue } from "../../graph/types";
import { hashCell2ToVec3 } from "./hash";

// Cellular noises for the library. Both are CHEAP 3×3 (9-tap) 2D loops — periodic via the wrapped cell hash
// (hashCell2ToVec3), so they tile seamlessly. `worley` (F1) uses the SAME PCG cell hash as the Blender
// Voronoi port, so it matches Blender's F1 k=0 layer visually while costing a third of the 3D 27-tap loop
// (the extra ±z layers rarely win the nearest-point search at z=0). `voronoi-smooth` is the @lumiey
// `voronoi12`: a soft-min blend of neighbouring cell values. (Blender's Smooth-F1 is a 5×5×5 / 125-tap loop
// that, ×supersampling ×octaves, overruns the GPU and causes a device loss — deliberately NOT used here.)
// Bases take the period-scaled 2D coord `p` and a square period (cellular noises ignore aspect). `period`
// may be a JS number or a uniform node (a live `scale`). Returns [0,1].
type V = MaterialValue;
const SMOOTH_EXP = 2.0; // 1 / edge-smoothness (smoothness 0.5)

// Worley (F1): 1 − distance-to-nearest-feature, in [0,1]. A 9-tap 2D search over the neighbour cells, each
// holding one feature point from the wrapped PCG hash (xy = jitter, z = the cell's own depth). The distance
// is measured in 3D against the plane point (f, 0) — i.e. Blender's F1 evaluated on its k=0 layer with
// randomness = 1 — so the pattern reads the same as the old 27-tap version but compiles/renders ~3× cheaper.
export function worleyBase01(p: V, perX: number | V, perY: number | V): V {
  const i = floor(p) as V;
  const f = p.sub(i) as V;
  const ix = int(i.x);
  const iy = int(i.y);
  const local = vec3(f.x, f.y, float(0)) as V;
  let d: V = float(1e10);
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      const h = hashCell2ToVec3(ix.add(dx), iy.add(dy), perX, perY) as V; // feature jitter (xy) + depth (z)
      const pp = vec3(float(dx).add(h.x), float(dy).add(h.y), h.z) as V; // feature point in this neighbour cell
      d = min(d, length(pp.sub(local))) as V;
    }
  return clamp(float(1).sub(d), 0, 1) as V;
}

// Smooth Voronoi value (@lumiey voronoi12): soft-min weighted average of neighbouring cell values. [0,1].
export function voronoiSmoothBase01(p: V, perX: number | V, perY: number | V): V {
  const i = floor(p) as V;
  const f = p.sub(i) as V;
  const ix = int(i.x);
  const iy = int(i.y);
  let va: V = float(0);
  let wt: V = float(0);
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      const o = hashCell2ToVec3(ix.add(dx), iy.add(dy), perX, perY) as V; // xy = offset, z = cell value
      const d = length(vec2(dx, dy).sub(f).add(vec2(o.x, o.y))) as V;
      const ww = pow(smoothstep(1.414, 0, d), SMOOTH_EXP) as V;
      va = va.add(o.z.mul(ww)) as V;
      wt = wt.add(ww) as V;
    }
  return va.div(wt.max(1e-4)) as V;
}
