import { Fn, float, vec2, vec3, length, atan, sin, cos, floor, fract, clamp, pow, smoothstep } from "three/tsl";
import type { MaterialValue } from "../graph/types";

// SHAPE — draws a single silhouette in a LOCAL coordinate frame (the unit disc ≈ the footprint), returning a
// `mask` (coverage) and a domed `height`. It is the swappable counterpart to Scatter: feed `Scatter.coord`
// here, or any other local/centred coordinate. It owns the silhouette so Scatter can stay shape-agnostic.
//   • blob    — round, optionally lumpy: the radius is distorted by angular harmonics whose phases come from
//               `seed` (wire Scatter.value) so every instance differs; `irregularity` 0 = circle.
//   • polygon — regular n-gon (angular shards): `sides` controls the count.
// The height is a smooth radial dome (no diagonal crease); `dome` curves it (<1 bulbous, >1 peaked).
type V = MaterialValue;
const TAU = 6.283185307179586;

export interface ShapeUniforms {
  irregularity: V; // 0..1 outline lumpiness (blob only)
  dome: V; // height profile exponent
  edge: V; // silhouette softness (normalised units)
}

export interface ShapeResult {
  mask: V;
  height: V;
}

export function shapeField(
  coord: V,
  type: string,
  sides: number,
  seedIn: V | null,
  u: ShapeUniforms,
): ShapeResult {
  const seed = seedIn ?? float(0);
  const packed = Fn(() => {
    const p = vec2(coord.x, coord.y) as V;
    const dist = length(p) as V;
    const ang = atan(coord.y, coord.x) as V;

    let mask: V;
    let inside: V; // distance INWARD from the outline, normalised: 0 at the edge → ~1 deep inside
    if (type === "polygon") {
      const n = Math.max(3, Math.round(sides));
      const seg = TAU / n;
      // distance along the inradius direction to this fragment; the boundary sits at the apothem.
      const dpoly = cos(floor(ang.div(seg).add(0.5)).mul(seg).sub(ang)).mul(dist) as V;
      const boundary = Math.cos(Math.PI / n); // apothem for circumradius 1
      const uNorm = clamp(dpoly.div(boundary), 0, 1) as V;
      mask = smoothstep(0, u.edge.add(1e-4), uNorm.oneMinus()) as V;
      inside = uNorm.oneMinus() as V;
    } else {
      // blob: the SILHOUETTE radius is distorted by per-instance random harmonics (phases from seed) so
      // every outline is a different lumpy shape; irregularity 0 = circle.
      const p1 = fract(seed.mul(13.13)).mul(TAU) as V;
      const p2 = fract(seed.mul(27.71)).mul(TAU) as V;
      const p3 = fract(seed.mul(51.37)).mul(TAU) as V;
      const lobes = sin(ang.mul(2).add(p1))
        .mul(0.5)
        .add(sin(ang.mul(3).add(p2)).mul(0.3))
        .add(sin(ang.mul(5).add(p3)).mul(0.2)) as V; // ~[-1,1]
      const rLumpy = float(1).add(lobes.mul(u.irregularity.mul(0.4))) as V;
      const uMask = clamp(dist.div(rLumpy.add(1e-6)), 0, 1) as V;
      mask = smoothstep(0, u.edge.add(1e-4), uMask.oneMinus()) as V;
      inside = uMask.oneMinus() as V;
    }

    // Height = a SMOOTH ROUNDED BODY: a circular dome faded to 0 at the rock's own (lumpy/angular) outline.
    //   • dome = (1 − r²)^dome — CIRCULAR (no angular term → no pinwheel) and zero-slope at the centre (→ no
    //     spike/pinch). This is the rounded pebble volume.
    //   • foot = smoothstep over `inside` — fades the body to 0 at the silhouette so the dome respects the
    //     irregular outline without a hard cliff.
    // There is deliberately NO flat plateau and NO separate bevel ramp; the surface texture (ruggedness) is
    // added uniformly OUTSIDE this node (in the preset) over the whole rock, so the top and sides match.
    const uCirc = clamp(dist, 0, 1) as V;
    const dome = pow(clamp(uCirc.mul(uCirc).oneMinus(), 0, 1), u.dome) as V;
    const foot = smoothstep(0, 0.3, inside) as V;
    const height = dome.mul(foot) as V;
    return vec3(mask, height, 0);
  })() as V;
  return { mask: packed.x, height: packed.y };
}
