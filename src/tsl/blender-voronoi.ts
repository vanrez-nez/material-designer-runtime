import { Fn, float, int, vec3, floor, select, max, mix, smoothstep, pow } from "three/tsl";
import type { MaterialValue } from "../graph/types";

// Faithful TSL port of Blender's Voronoi — plan L4 / decision 2. Transcribed verbatim from Blender GPU
// source:
//   - cell hash: gpu_shader_common_hash.glsl — hash_pcg3d_i (int3 PCG) + hash_int3_to_vec3.
//   - features:  gpu_shader_material_voronoi.glsl — voronoi_distance (metric), voronoi_f1, voronoi_f2,
//                voronoi_smooth_f1, voronoi_distance_to_edge.
// Verified against a pure-JS implementation of the same algorithm (the authoritative per-node check).
// Metrics: 0 Euclidean, 1 Manhattan, 2 Chebychev, 3 Minkowski (uses the exponent). Features expose
// Distance/Color/Position (each output re-runs the loop; only connected outputs compile).
type V = MaterialValue;
const INV_2147483648 = 1 / 0x80000000; // float(0x7fffffff) rounds to 2147483648 in f32 — match Blender.

function hashInt3ToVec3(kx: V, ky: V, kz: V): V {
  const x = kx.mul(1664525).add(1013904223).toVar();
  const y = ky.mul(1664525).add(1013904223).toVar();
  const z = kz.mul(1664525).add(1013904223).toVar();
  x.assign(x.add(y.mul(z)));
  y.assign(y.add(z.mul(x)));
  z.assign(z.add(x.mul(y)));
  x.assign(x.bitXor(x.shiftRight(16)));
  y.assign(y.bitXor(y.shiftRight(16)));
  z.assign(z.bitXor(z.shiftRight(16)));
  x.assign(x.add(y.mul(z)));
  y.assign(y.add(z.mul(x)));
  z.assign(z.add(x.mul(y)));
  const mask = int(0x7fffffff);
  return vec3(
    float(x.bitAnd(mask)).mul(INV_2147483648),
    float(y.bitAnd(mask)).mul(INV_2147483648),
    float(z.bitAnd(mask)).mul(INV_2147483648),
  );
}

// Floored modulo of an integer cell coordinate into [0, period). Wrapping the PCG-hash input makes the
// random feature points periodic, so a Voronoi cell at index `period` matches index 0 — the offline tile
// edge becomes seamless. (The neighbour offset i/j/k stays unwrapped, so distances are unaffected.) `period`
// may be a uniform node (a live-tweakable scale that re-renders without recompiling) — the node math works
// for both a JS number and a uniform.
function wrapCell(v: V, period: number | V): V {
  return v.sub(int(floor(float(v).div(period))).mul(int(period)));
}

// Hash a cell, optionally wrapped to `period` for seamless tiling. A literal number <= 0 means the faithful,
// non-tiling 3D path (live backend); a positive number or a uniform node wraps the hash (offline tiling).
function cellHash(ix: V, iy: V, iz: V, period: number | V): V {
  if (typeof period === "number" && period <= 0) return hashInt3ToVec3(ix, iy, iz);
  return hashInt3ToVec3(wrapCell(ix, period), wrapCell(iy, period), wrapCell(iz, period));
}

// voronoi_distance for one metric (build-time selected). exponent is used only for Minkowski.
function voronoiDistance(a: V, b: V, metric: number, exponent: V): V {
  const d = a.sub(b).abs();
  if (metric === 1) return d.x.add(d.y).add(d.z); // Manhattan
  if (metric === 2) return d.x.max(d.y.max(d.z)); // Chebychev
  if (metric === 3) {
    // Minkowski: pow(Σ pow(|di|, e), 1/e)
    const e = exponent;
    return pow(pow(d.x, e).add(pow(d.y, e)).add(pow(d.z, e)), float(1).div(e));
  }
  return a.sub(b).length(); // Euclidean
}

type Want = "distance" | "color" | "position";

// F1: closest point. Tracks the winning offset so it can emit Distance / Color / Position.
function voronoiF1(coord: V, randomness: V, metric: number, exponent: V, want: Want, period: number | V): V {
  return Fn(() => {
    const cell = floor(coord) as V;
    const local = coord.sub(cell);
    const cx = int(cell.x);
    const cy = int(cell.y);
    const cz = int(cell.z);
    const minDist = float(1e10).toVar();
    const tOff = vec3(0, 0, 0).toVar();
    const tPos = vec3(0, 0, 0).toVar();
    for (let k = -1; k <= 1; k++)
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const off = vec3(i, j, k);
          const pp = off.add(cellHash(cx.add(i), cy.add(j), cz.add(k), period).mul(randomness));
          const d = voronoiDistance(pp, local, metric, exponent);
          const closer = d.lessThan(minDist);
          minDist.assign(closer.select(d, minDist));
          tOff.assign(closer.select(off, tOff));
          tPos.assign(closer.select(pp, tPos));
        }
    if (want === "color")
      return cellHash(cx.add(int(tOff.x)), cy.add(int(tOff.y)), cz.add(int(tOff.z)), period);
    if (want === "position") return tPos.add(cell);
    return minDist;
  })();
}

// F2: second-closest point (tracks both F1 and F2; updates from the old state each step).
function voronoiF2(coord: V, randomness: V, metric: number, exponent: V, want: Want, period: number | V): V {
  return Fn(() => {
    const cell = floor(coord) as V;
    const local = coord.sub(cell);
    const cx = int(cell.x);
    const cy = int(cell.y);
    const cz = int(cell.z);
    const dF1 = float(1e10).toVar();
    const dF2 = float(1e10).toVar();
    const offF1 = vec3(0, 0, 0).toVar();
    const offF2 = vec3(0, 0, 0).toVar();
    const posF1 = vec3(0, 0, 0).toVar();
    const posF2 = vec3(0, 0, 0).toVar();
    for (let k = -1; k <= 1; k++)
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const off = vec3(i, j, k);
          const pp = off.add(cellHash(cx.add(i), cy.add(j), cz.add(k), period).mul(randomness));
          const d = voronoiDistance(pp, local, metric, exponent);
          // Snapshot the comparisons into vars: dF1/dF2 are reassigned below, so an expression-based
          // isF1/isF2 would re-read the *new* values in the later (offset/position) selects.
          const isF1 = d.lessThan(dF1).toVar();
          const isF2 = d.lessThan(dF2).toVar();
          // Compute next state from the OLD state (F2 inherits the old F1 when a new F1 is found).
          const nDF2 = select(isF1, dF1, select(isF2, d, dF2));
          const nOffF2 = select(isF1, offF1, select(isF2, off, offF2));
          const nPosF2 = select(isF1, posF1, select(isF2, pp, posF2));
          const nDF1 = select(isF1, d, dF1);
          const nOffF1 = select(isF1, off, offF1);
          const nPosF1 = select(isF1, pp, posF1);
          // Assign F2 first: its new value reads the OLD F1 (TSL vars are by-reference, so updating F1
          // before F2 would feed the new F1 into F2 — which made F2 track F1).
          dF2.assign(nDF2);
          offF2.assign(nOffF2);
          posF2.assign(nPosF2);
          dF1.assign(nDF1);
          offF1.assign(nOffF1);
          posF1.assign(nPosF1);
        }
    if (want === "color")
      return cellHash(cx.add(int(offF2.x)), cy.add(int(offF2.y)), cz.add(int(offF2.z)), period);
    if (want === "position") return posF2.add(cell);
    return dF2;
  })();
}

// Smooth F1: smooth-minimum blend (smoothness param). Stateful accumulation of distance/color/pos.
// GPU-SAFETY: Blender's reference uses a 5×5×5 (125-tap) neighbourhood, but at the offline bake's 4×
// supersample that overruns the GPU and triggers a device loss (it took out the whole context once). The
// loop is build-time, so it can't shrink with the smoothness uniform — instead it's fixed at 3×3×3 (27-tap,
// the same cost as F1/F2, which are proven safe). For the smoothness range this node exposes (0–1, the
// soft-min weight of a cell ≥2 units away is ~0 once `0.5 + (smoothD−d)·0.5/sm` clamps below 0), the outer
// ring contributes negligibly, so the result is visually equivalent to the 125-tap version.
const SMOOTH_RADIUS = 1; // 3×3×3 = 27 taps (was 2 → 5×5×5 = 125, which device-loses in the bake)
function voronoiSmoothF1(
  coord: V,
  randomness: V,
  metric: number,
  exponent: V,
  smoothness: V,
  want: Want,
  period: number | V,
): V {
  return Fn(() => {
    const cell = floor(coord) as V;
    const local = coord.sub(cell);
    const cx = int(cell.x);
    const cy = int(cell.y);
    const cz = int(cell.z);
    const sm = max(smoothness, float(1e-6)); // guard the /smoothness divide
    const smoothD = float(0).toVar();
    const smoothC = vec3(0, 0, 0).toVar();
    const smoothP = vec3(0, 0, 0).toVar();
    const h = float(-1).toVar();
    for (let k = -SMOOTH_RADIUS; k <= SMOOTH_RADIUS; k++)
      for (let j = -SMOOTH_RADIUS; j <= SMOOTH_RADIUS; j++)
        for (let i = -SMOOTH_RADIUS; i <= SMOOTH_RADIUS; i++) {
          const off = vec3(i, j, k);
          const rnd = cellHash(cx.add(i), cy.add(j), cz.add(k), period); // = cell colour
          const pp = off.add(rnd.mul(randomness));
          const d = voronoiDistance(pp, local, metric, exponent);
          h.assign(
            select(
              h.equal(-1),
              float(1),
              smoothstep(0, 1, float(0.5).add(smoothD.sub(d).mul(0.5).div(sm))),
            ),
          );
          const corr = sm.mul(h).mul(float(1).sub(h)).toVar();
          smoothD.assign(mix(smoothD, d, h).sub(corr));
          corr.assign(corr.div(float(1).add(sm.mul(3))));
          smoothC.assign(mix(smoothC, rnd, h).sub(corr));
          smoothP.assign(mix(smoothP, pp, h).sub(corr));
        }
    if (want === "color") return smoothC;
    if (want === "position") return smoothP.add(cell);
    return smoothD;
  })();
}

// Public per-feature, per-output accessors (the node calls the ones it needs). `period` > 0 wraps the cell
// hash for seamless tiling over a [0, period) tile (the offline bake); 0 keeps the faithful, non-tiling 3D.
export const blenderVoronoiF1 = (c: V, r: V, m: number, e: V, period: number | V = 0): V =>
  voronoiF1(c, r, m, e, "distance", period);
export const blenderVoronoiF1Color = (c: V, r: V, m: number, e: V, period: number | V = 0): V =>
  voronoiF1(c, r, m, e, "color", period);
export const blenderVoronoiF1Pos = (c: V, r: V, m: number, e: V, period: number | V = 0): V =>
  voronoiF1(c, r, m, e, "position", period);
export const blenderVoronoiF2 = (c: V, r: V, m: number, e: V, period: number | V = 0): V =>
  voronoiF2(c, r, m, e, "distance", period);
export const blenderVoronoiF2Color = (c: V, r: V, m: number, e: V, period: number | V = 0): V =>
  voronoiF2(c, r, m, e, "color", period);
export const blenderVoronoiF2Pos = (c: V, r: V, m: number, e: V, period: number | V = 0): V =>
  voronoiF2(c, r, m, e, "position", period);
export const blenderVoronoiSmoothF1 = (c: V, r: V, m: number, e: V, s: V, period: number | V = 0): V =>
  voronoiSmoothF1(c, r, m, e, s, "distance", period);
export const blenderVoronoiSmoothF1Color = (c: V, r: V, m: number, e: V, s: V, period: number | V = 0): V =>
  voronoiSmoothF1(c, r, m, e, s, "color", period);
export const blenderVoronoiSmoothF1Pos = (c: V, r: V, m: number, e: V, s: V, period: number | V = 0): V =>
  voronoiSmoothF1(c, r, m, e, s, "position", period);

// Distance to Edge (two passes; squared-Euclidean dot, metric-independent — matches Blender).
export function blenderVoronoiDistanceToEdge(coord: V, randomness: V, period: number | V = 0): V {
  return Fn(() => {
    const cell = floor(coord) as V;
    const local = coord.sub(cell);
    const cx = int(cell.x);
    const cy = int(cell.y);
    const cz = int(cell.z);
    const point = (i: number, j: number, k: number): V =>
      vec3(i, j, k).add(cellHash(cx.add(i), cy.add(j), cz.add(k), period).mul(randomness)).sub(local);
    const vectorToClosest = vec3(0, 0, 0).toVar();
    const minDist = float(1e10).toVar();
    for (let k = -1; k <= 1; k++)
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const vp = point(i, j, k);
          const d = vp.dot(vp);
          const closer = d.lessThan(minDist);
          minDist.assign(closer.select(d, minDist));
          vectorToClosest.assign(closer.select(vp, vectorToClosest));
        }
    const minEdge = float(1e10).toVar();
    for (let k = -1; k <= 1; k++)
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const vp = point(i, j, k);
          const perp = vp.sub(vectorToClosest);
          const onEdge = perp.dot(perp).greaterThan(0.0001);
          const distanceToEdge = vectorToClosest.add(vp).div(2).dot(perp.normalize());
          minEdge.assign(onEdge.select(minEdge.min(distanceToEdge), minEdge));
        }
    return minEdge;
  })();
}
