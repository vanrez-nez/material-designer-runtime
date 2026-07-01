import { Fn, float, bool, select, mix, saturate, texture, parallaxDirection } from "three/tsl";
import type { Texture } from "three/webgpu";
import type { MaterialValue } from "../graph/types";

type V = MaterialValue;

// Grazing-angle clamp: the per-depth UV shift is viewDir.xy / viewDir.z, which blows up as the view
// approaches the surface plane (z → 0). Flooring |z| caps the shift so near-edge fragments don't smear.
const MIN_VIEW_Z = 0.3;

// Steep Parallax Occlusion Mapping over a baked height field. Marches the tangent-space view ray through
// the height map and returns the UV where the ray first dips below the surface, giving motion parallax and
// self-occlusion a normal map alone can't. Height convention matches the rest of the graph: white = raised,
// so surface depth = 1 - height.
//
// UV-space only — used by the offline surface's non-triplanar path (a flat floor's derivative-based TBN
// works without precomputed tangents). The march is JS-unrolled (like tile.ts / scatter.ts) so every
// texture sample sits in straight-line, uniform control flow — WGSL forbids implicit-derivative sampling
// inside a dynamic loop, and unrolling sidesteps it without needing explicit gradients. Layer selection is
// branchless (`select`), freezing the result UV at the first crossing.
export function parallaxOcclusionUV(heightMap: Texture, baseUv: V, scale: V, layers: number): V {
  return Fn(() => {
    // Tangent-space view direction (fragment → camera): xy is the in-plane shear, z the facing term.
    // NOTE: three's `parallaxDirection` is deliberately NOT normalized (its `.normalize()` is commented out)
    // — it's tuned for the single-step `parallaxUV`, where the leftover magnitude bakes in a cosine factor.
    // For a marching ray we need a unit direction, or the offset magnitude blows up and smears the texture.
    const viewDir = (parallaxDirection as V).normalize();
    const h = (uvc: V): V => texture(heightMap, uvc).x; // sampled height [0,1]

    const invN = 1 / layers;
    // Total UV shift over the full [0,1] depth range; /z deepens it at grazing angles (steep POM).
    const maxOffset = viewDir.xy.div(viewDir.z.abs().max(MIN_VIEW_Z)).mul(scale) as V;
    const deltaUv = maxOffset.mul(invN) as V; // per-layer step

    const resultUv = baseUv.toVar();
    const found = bool(false).toVar();

    let curUv: V = baseUv; // node, rebuilt each unrolled step
    let curDepth: V = float(1).sub(h(curUv)); // surface depth at curUv

    for (let i = 0; i < layers; i++) {
      const advancedUv = curUv.sub(deltaUv) as V;
      const advDepth = float(1).sub(h(advancedUv)) as V; // surface depth one step further along the ray
      const layerDepth = (i + 1) * invN; // ray depth after this advance
      const crossed = float(layerDepth).greaterThanEqual(advDepth) as V;

      // Linear-interpolate the intersection between this layer and the previous (LearnOpenGL occlusion step).
      const afterDepth = advDepth.sub(layerDepth) as V;
      const beforeDepth = curDepth.sub(i * invN) as V;
      // saturate: on a low-contrast height field the two layer depths nearly coincide, so the divisor →0 and
      // an unclamped weight would extrapolate the UV far outside the marched segment (→ per-pixel garbage,
      // texture smears to grit). Clamping to [0,1] keeps the hit between the two sampled layers.
      const weight = saturate(afterDepth.div(afterDepth.sub(beforeDepth).max(1e-5))) as V;
      const hitUv = mix(advancedUv, curUv, weight) as V;

      // Freeze the result at the first crossing; later layers leave it untouched.
      resultUv.assign(select(found.not().and(crossed), hitUv, resultUv));
      found.assign(found.or(crossed));

      curUv = advancedUv;
      curDepth = advDepth;
    }

    return resultUv;
  })();
}
