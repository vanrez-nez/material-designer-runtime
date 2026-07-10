import { float, smoothstep, fwidth, max } from "three/tsl";
import type { MaterialNodeDef, MaterialValue } from "../../types";

// Height Blend — produces a feature-aware mask (`fac`) for the Mix Shader, so a transition between two
// materials follows their SURFACE FEATURES instead of being a flat crossfade. It compares the two materials'
// height fields biased by `transition`, with a soft `width`:
//   fac = smoothstep(-width, +width, (heightB - heightA) + (2*transition - 1))
// As `transition` rises, material B wins first where ITS height is high (gravel pebbles poke through the tile
// grout, then spread) → a natural, interlocking border. This is just ONE mask source: it's optional and
// decoupled — feed Mix Shader a plain noise/gradient/slope for a non-height (linear) terrain transition.
// Plug an optional `breakup` field to make the border ragged rather than a clean height contour.
type V = MaterialValue;

export const heightBlendNode: MaterialNodeDef = {
  type: "height-blend",
  nodeClass: "converter",
  label: "Height Blend",
  inputs: [
    { key: "heightA", label: "Height A", kind: "float" },
    { key: "heightB", label: "Height B", kind: "float" },
    { key: "breakup", label: "Breakup", kind: "float" },
  ],
  outputs: [{ key: "fac", kind: "float" }],
  params: [
    { key: "transition", label: "transition", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 },
    // min 0 is safe: build() floors the smoothstep band at fwidth(d) (one texel/pixel), so width=0 yields a
    // crisp, analytically anti-aliased edge rather than the degenerate smoothstep(0,0) divide-by-zero.
    { key: "width", label: "width", type: "float", min: 0, max: 1, step: 0.01, default: 0.25 },
    { key: "breakup", label: "breakup amt", type: "float", min: 0, max: 1, step: 0.01, default: 0 },
  ],
  build(ctx) {
    const hA = (ctx.inputs.heightA ?? float(0.5)) as V;
    let hB = (ctx.inputs.heightB ?? float(0.5)) as V;
    const t = ctx.live("transition") as V;
    const w = ctx.live("width") as V;
    // Optional ragged border: perturb B's height by a breakup field (centered) × amount.
    if (ctx.inputs.breakup !== undefined) {
      hB = hB.add((ctx.inputs.breakup as V).sub(0.5).mul(ctx.live("breakup"))) as V;
    }
    const d = hB.sub(hA).add(t.mul(2).sub(1)) as V; // relative height, biased by transition
    // Analytic anti-alias: never let the edge band be narrower than one screen-pixel / bake-texel step
    // (fwidth(d) = |d change| per fragment). `width` stays the artistic soft-blend control; the derivative
    // term only takes over when width is sub-texel, so a "hard" mask (width→0) anti-aliases into a crisp
    // 1-texel edge instead of staircasing, while a genuine soft transition (large width) is unaffected.
    const e = max(w, fwidth(d)) as V;
    return { fac: smoothstep(e.negate(), e, d) };
  },
};
