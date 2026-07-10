import { bumpMap, float, vec2, vec3, normalize, dFdx, dFdy, uv } from "three/tsl";
import type { MaterialNodeDef, MaterialValue } from "../../types";

type V = MaterialValue; // loose TSL value (= any); the three/tsl overloads are stricter than we need.

// Max tangent-space slope. The uv-gradient of a high-frequency procedural height (bark fibers, asphalt
// grit) is genuinely huge — dh/du in the hundreds — so an unclamped `vec3(-dh/du, -dh/dv, 1)` normalizes
// to a vector lying almost IN the tangent plane (z ≈ 0). That perturbed normal is ~perpendicular to the
// geometry normal, which collapses N·L to ~0 and turns the whole surface black under direct light. Bounding
// the slope keeps z ≥ 1/√(1+MAX²) so the normal can never go degenerate, regardless of strength or height
// frequency. MAX = 8 → tilt ≤ ~83°, z ≥ 0.124. This ceiling assumes the height carries per-texel detail
// (erosion, interior noise) so slopes VARY — a perfectly smooth steep feature would still saturate to a
// near-constant tilt and read faceted; rough the height, don't lower this back.
//
// The bound must be a SOFT compression, never a hard clamp: a hard clamp maps every slope above MAX to
// exactly MAX, so any steep smooth feature (a pebble dome, a dune) bakes a constant-tilt normal whose only
// variation is direction — which is the shading of a CONE. Every scattered rock rendered as a "pinched"
// cone with radial facet creases until this was made smooth (s·MAX/√(MAX²+s²): identity for small slopes,
// asymptote MAX, monotonic — curvature survives compression).
const MAX_SLOPE = 8.0;

// Derives a surface normal from a scalar height field — backend-aware:
//   live    → bumpMap (screen-space derivative bump over positionWorld; a perturbed world normal).
//   offline → an ENCODED tangent-space normal map: from the height's uv-gradient. Dividing the height
//             derivative by the uv derivative (dFdx(h)/dFdx(uv.x)) yields dh/du independent of bake
//             resolution. The slope is then clamped (see MAX_SLOPE) so steep heights don't bake a
//             degenerate, lighting-breaking normal. Sampled on the surface via triplanarNormalMap / normalMap.
export const normalFromHeightNode: MaterialNodeDef = {
  type: "normal-from-height",
  nodeClass: "vector",
  label: "Normal From Height",
  // Takes dFdx/dFdy of the height (offline) → its dependency-path caches bake supersampled (see compiler).
  bakeDerivative: true,
  inputs: [{ key: "height", kind: "float" }],
  outputs: [{ key: "normal", kind: "vector" }],
  params: [
    { key: "strength", label: "strength", type: "float", min: 0, max: 2, step: 0.01, default: 0.2 },
  ],
  build(ctx) {
    const h = ctx.inputs.height ?? float(0.5);
    if (ctx.backend === "live") {
      return { normal: bumpMap(h, ctx.live("strength")) };
    }
    // offline: tangent-space normal from the resolution-independent uv-gradient of the height.
    const hv = h as V;
    const u = uv() as V;
    const dhdu = dFdx(hv).div(dFdx(u.x)) as V;
    const dhdv = dFdy(hv).div(dFdy(u.y)) as V;
    const s = ctx.live("strength") as V;
    // Compress the slope toward MAX_SLOPE smoothly (s·MAX/√(MAX²+s²)) so the normal can't collapse into
    // the tangent plane, while steep smooth features keep their curvature — see MAX_SLOPE.
    const slope = vec2(dhdu, dhdv).mul(s) as V;
    const maxLen = float(MAX_SLOPE);
    const soft = slope.mul(maxLen.div(slope.length().pow(2).add(maxLen.mul(maxLen)).sqrt())) as V;
    const n = normalize(vec3(soft.x.negate(), soft.y.negate(), float(1))) as V;
    return { normal: n.mul(0.5).add(0.5) }; // encode [-1,1] → [0,1] for the normal-map texture
  },
};
