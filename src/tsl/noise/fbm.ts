import { Break, Fn, If, Loop, vec2, float, fwidth, smoothstep, clamp, mix, max, min } from "three/tsl";
import type { MaterialValue } from "../../graph/types";

// Generic periodic fBm for the noise library: sums a base noise over octaves whose period scales by
// lacunarity^o (a WHOLE-number lacunarity so every octave's integer period stays integer → the sum tiles
// seamlessly over the uv tile, exactly like tileableFbm). The base returns ~[0,1]; the result is the
// amplitude-weighted average, also ~[0,1]. `octaves`/`lacunarity` become a compact WGSL loop and `gain` is a
// live uniform.
type V = MaterialValue;

// base(p, perX, perY): noise sampled at the (already period-scaled) coordinate `p`, wrapping its integer
// cells at (perX, perY). Returns ~[0,1].
export type NoiseBase01 = (p: V, perX: number, perY: number) => V;

export function periodicFbm01(
  uv2: V,
  periodX: number | V,
  periodY: number | V,
  octaves: number,
  gain: V,
  base: NoiseBase01,
  // Optional anti-alias strength (0..1). When passed (offline only — `fwidth` needs the bake's screen-space
  // derivatives), each octave's amplitude is faded out as its cells shrink below the bake texel grid, so the
  // sum never contains frequencies the texture can't represent (which otherwise ALIAS into speckle/mush,
  // e.g. via Normal From Height). 0 = the raw, unfiltered sum; 1 = full band-limit. Undefined = no filtering.
  aa?: V,
  // Per-octave period multiplier. MUST be a whole number (offline seamless tiling needs integer octave
  // periods). Default 2 = the classic ×2 octave (identical to the old hardcoded `1<<o`).
  lacunarity = 2,
): V {
  return Fn(() => {
    // The base period may be a JS number (build-time) OR a uniform node (a live-tweakable `scale` that
    // re-renders without recompiling). Coerce to a node so the octave scaling and wrapping use node math.
    const px: V = typeof periodX === "number" ? float(Math.max(1, Math.round(periodX))) : periodX;
    const py: V = typeof periodY === "number" ? float(Math.max(1, Math.round(periodY))) : periodY;
    const fw: V = fwidth(uv2);
    const sum = float(0).toVar();
    const ampSum = float(0).toVar();
    const amp = float(1).toVar();
    const frequency = float(1).toVar();
    const lac = Math.max(2, Math.round(lacunarity));
    Loop(Math.max(1, octaves), () => {
      const pxo = px.mul(frequency) as V;
      const pyo = py.mul(frequency) as V;
      const p = uv2.mul(vec2(pxo, pyo)) as V;
      let w: V = amp;
      if (aa !== undefined) {
        const cpp = max(pxo.mul(fw.x), pyo.mul(fw.y)) as V;
        const roll = clamp(float(1).sub(smoothstep(0.2, 0.5, cpp)), 0, 1) as V;
        w = amp.mul(mix(float(1), roll, aa)) as V;
      }
      If(w.lessThanEqual(0), () => Break());
      sum.addAssign(w.mul(base(p, pxo, pyo)));
      ampSum.addAssign(w);
      amp.mulAssign(gain);
      frequency.mulAssign(lac);
    });
    // Weighted average, but converge to the noise MEAN (0.5 for these [0,1] bases) as the surviving octave
    // weight drops below 1 — so a fully band-limited noise fades to flat mid-grey.
    return mix(float(0.5), sum.div(ampSum.max(1e-4)), min(ampSum, 1)) as V;
  })() as V;
}
