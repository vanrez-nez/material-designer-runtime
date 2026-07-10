import { Fn, float, vec2, vec3, length, atan, sin, cos, floor, fract, clamp, pow, smoothstep } from "three/tsl";
import type { MaterialValue } from "../graph/types";

// SHAPE — draws a single silhouette in a LOCAL coordinate frame (the unit disc ≈ the footprint), returning a
// `mask` (coverage) and a domed `height`. It is the swappable counterpart to Scatter: feed `Scatter.coord`
// here, or any other local/centred coordinate. It owns the silhouette so Scatter can stay shape-agnostic.
//   • blob    — round, optionally lumpy: the radius is distorted by angular harmonics whose phases come from
//               `seed` (wire Scatter.value) so every instance differs; `irregularity` 0 = circle.
//   • polygon — regular n-gon (angular shards): `sides` controls the count.
// The height is a smooth radial dome (no diagonal crease); `dome` curves it (<1 bulbous, >1 peaked).
//
// EROSION (`erode`): a slope-blur-equivalent the node performs on ITSELF — the compiler builds each node's
// inputs once over one coordinate, so a downstream node can never re-evaluate its upstream at shifted coords
// (what SD's raster Slope Blur does). But shape OWNS its silhouette function, so it can: the body is
// re-evaluated at a small ring of offset taps and min-combined, chipping/melting the outline and undercutting
// the dome asymmetrically (tap ring rotated per instance by seed). erode = 0 leaves the shape bit-identical.
type V = MaterialValue;
const TAU = 6.283185307179586;
const ERODE_TAPS = 4; // ring taps re-evaluating the body (unrolled; ~5× the silhouette math when eroding)
const ERODE_RADII = [0.13, 0.21, 0.09, 0.17]; // per-tap radius factors — asymmetric chips, not a uniform shrink

export interface ShapeUniforms {
  irregularity: V; // 0..1 outline lumpiness (blob only)
  dome: V; // height profile exponent
  edge: V; // silhouette softness (normalised units)
  tilt: V; // 0..1 per-instance directional gradient on the top (seed-driven direction) — slabs lying at angles
  formRandom: V; // 0..1 per-instance dome-exponent jitter — sharp AND flat stones from one layer
  erode: V; // 0..1 min-tap self-erosion of outline + body (see EROSION above)
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
    // Per-instance hashes (shared by every tap so erosion moves the SAME stone, not a different one).
    const p1 = fract(seed.mul(13.13)).mul(TAU) as V;
    const p2 = fract(seed.mul(27.71)).mul(TAU) as V;
    const p3 = fract(seed.mul(51.37)).mul(TAU) as V;
    const expJit = fract(seed.mul(91.7)).mul(2).sub(1) as V; // [-1,1] per instance
    const domeExp = u.dome.mul(float(1).add(u.formRandom.mul(expJit).mul(0.8))).max(0.2) as V;
    const tiltAng = fract(seed.mul(71.13)).mul(TAU) as V;

    // One full silhouette + body evaluation at (px, py) — the unit the erosion taps re-run.
    const sample = (px: V, py: V): { mask: V; height: V } => {
      const p = vec2(px, py) as V;
      const dist = length(p) as V;
      const ang = atan(py, px) as V;

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
      //   • dome = (1 − r²)^exp — CIRCULAR (no angular term → no pinwheel) and zero-slope at the centre (→ no
      //     spike/pinch). `formRandom` jitters exp per instance (sharp AND flat stones from one layer).
      //   • `tilt` multiplies a per-instance directional gradient over the body — stones lying at angles.
      //   • foot = smoothstep over `inside` — fades the body to 0 at the silhouette so the dome respects the
      //     irregular outline without a hard cliff.
      // There is deliberately NO flat plateau and NO separate bevel ramp; the surface texture (ruggedness) is
      // added uniformly OUTSIDE this node (in the preset) over the whole rock, so the top and sides match.
      const uCirc = clamp(dist, 0, 1) as V;
      const dome = pow(clamp(uCirc.mul(uCirc).oneMinus(), 0, 1), domeExp) as V;
      const tiltDot = cos(tiltAng).mul(px).add(sin(tiltAng).mul(py)) as V;
      const tilted = dome.mul(clamp(float(1).add(u.tilt.mul(tiltDot)), 0, 2)) as V;
      const foot = smoothstep(0, 0.3, inside) as V;
      const height = clamp(tilted, 0, 1.5).mul(foot) as V;
      return { mask, height };
    };

    const centre = sample(coord.x, coord.y);
    let mask = centre.mask;
    let height = centre.height;
    // Min-tap erosion: ring rotated per instance; per-tap radii differ so chips are asymmetric. With
    // erode = 0 every tap lands on the centre sample and the min is a no-op.
    const ringRot = fract(seed.mul(33.19)).mul(TAU) as V;
    for (let i = 0; i < ERODE_TAPS; i++) {
      const a = ringRot.add((i / ERODE_TAPS) * TAU) as V;
      const rad = u.erode.mul(ERODE_RADII[i]) as V;
      const s = sample(coord.x.add(cos(a).mul(rad)), coord.y.add(sin(a).mul(rad)));
      mask = mask.min(s.mask) as V;
      height = height.min(s.height) as V;
    }
    return vec3(mask, height, 0);
  })() as V;
  return { mask: packed.x, height: packed.y };
}
