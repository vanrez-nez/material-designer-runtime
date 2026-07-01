import { vec2, vec3, float, floor, step, mod, cos, sin, dot, max, clamp } from "three/tsl";
import type { MaterialValue } from "../../graph/types";

// Periodic simplex noise — Stefan Gustavson's `psrdnoise2` period handling (MIT/public-domain), value-only
// (no gradient rotation). The naive "wrap the skewed cell index" approach seams in a square uv tile because
// the shear maps a y-period to a half-cell shift; psrdnoise fixes this by wrapping the unskewed VERTEX
// POSITIONS to the period, then transforming back to simplex indices — so it tiles a rectangular period in
// (x,y). Gradient angles come from the canonical periodic polynomial hash (periodic via the wrapped indices),
// which is pure float math (no stateful vars). `p` is the period-scaled coord; perX/perY the periods. [0,1].
type V = MaterialValue;

export function simplexBase01(p: V, perX: number, perY: number): V {
  const uv = vec2(p.x.add(p.y.mul(0.5)), p.y) as V;
  const i0 = floor(uv) as V;
  const f0 = uv.sub(i0) as V;
  const cmp = step(f0.y, f0.x) as V;
  const o1 = vec2(cmp, float(1).sub(cmp)) as V;
  const v0 = vec2(i0.x.sub(i0.y.mul(0.5)), i0.y) as V;
  const v1 = vec2(v0.x.add(o1.x).sub(o1.y.mul(0.5)), v0.y.add(o1.y)) as V;
  const v2 = vec2(v0.x.add(0.5), v0.y.add(1)) as V;
  const x0 = p.sub(v0) as V;
  const x1 = p.sub(v1) as V;
  const x2 = p.sub(v2) as V;

  // Wrap unskewed vertex positions to the period, then back to simplex indices (the skew-correct wrap).
  const xw = mod(vec3(v0.x, v1.x, v2.x), float(perX)) as V;
  const yw = mod(vec3(v0.y, v1.y, v2.y), float(perY)) as V;
  const iu = floor(xw.add(yw.mul(0.5)).add(0.5)) as V;
  const iv = floor(yw.add(0.5)) as V;

  // Canonical periodic polynomial hash → per-vertex gradient angle.
  let hash = mod(iu, 289) as V;
  hash = mod(hash.mul(51).add(2).mul(hash).add(iv), 289) as V;
  hash = mod(hash.mul(34).add(10).mul(hash), 289) as V;
  const psi = hash.mul(0.07482) as V;
  const gx = cos(psi) as V;
  const gy = sin(psi) as V;
  const g0 = vec2(gx.x, gy.x) as V;
  const g1 = vec2(gx.y, gy.y) as V;
  const g2 = vec2(gx.z, gy.z) as V;

  const w = max(float(0.8).sub(vec3(dot(x0, x0), dot(x1, x1), dot(x2, x2))), 0) as V;
  const w2 = w.mul(w) as V;
  const w4 = w2.mul(w2) as V;
  const gdotx = vec3(dot(g0, x0), dot(g1, x1), dot(g2, x2)) as V;
  const n = dot(w4, gdotx) as V;
  return clamp(n.mul(10.9).mul(0.5).add(0.5), 0, 1) as V;
}
