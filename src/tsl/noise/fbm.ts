import { vec2, float, fwidth, smoothstep, clamp, mix, max, min } from "three/tsl";
import type { MaterialValue } from "../../graph/types";

// Generic periodic fBm for the noise library: sums a base noise over octaves whose period scales by
// lacunarity^o (a WHOLE-number lacunarity so every octave's integer period stays integer → the sum tiles
// seamlessly over the uv tile, exactly like tileableFbm). The base returns ~[0,1]; the result is the
// amplitude-weighted average, also ~[0,1]. `octaves`/`lacunarity` are build-time counts (JS loop unroll),
// `gain` a live uniform.
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
  // The base period may be a JS number (build-time) OR a uniform node (a live-tweakable `scale` that
  // re-renders without recompiling). Coerce to a node so the octave scaling (×2^o) and the wrap use node math
  // either way; a numeric period is rounded/clamped up front, a uniform one is expected already integer
  // (rounded in-shader by the caller — see tileable-noise.ts) so the lattice still tiles.
  const px: V = typeof periodX === "number" ? float(Math.max(1, Math.round(periodX))) : periodX;
  const py: V = typeof periodY === "number" ? float(Math.max(1, Math.round(periodY))) : periodY;
  // uv change per bake texel (accounts for supersampling + any upstream warp of the coord).
  const fw: V = fwidth(uv2);
  let sum: V = float(0);
  let ampSum: V = float(0);
  let amp: V = float(1);
  const lac = Math.max(2, Math.round(lacunarity));
  for (let o = 0; o < Math.max(1, octaves); o++) {
    const f = Math.round(Math.pow(lac, o)); // lacunarity^o (integer → octave period stays whole → tiles)
    const pxo = px.mul(f) as V;
    const pyo = py.mul(f) as V;
    const p = uv2.mul(vec2(pxo, pyo)) as V;
    // Effective weight: amplitude faded by how far this octave sits past the texel-grid Nyquist. cells-per-
    // texel = period·fw (per axis, take the worst); fade from ~⅓ to ~⅔ of a texel. Weighting BOTH sum and
    // ampSum keeps the [0,1]/[-1,1] mean put — the octave just contributes less as it vanishes.
    let w: V = amp;
    if (aa !== undefined) {
      const cpp = max(pxo.mul(fw.x), pyo.mul(fw.y)) as V;
      // Fade from ~5 texels/cell (cpp 0.2) to fully gone at ~2 texels/cell (cpp 0.5, the sampling limit).
      // An octave at 2 texels/cell has ~full amplitude between adjacent texels, so Normal From Height turns
      // it into per-texel speckle; below ~4 texels/cell the derivative is still coherent, so keep it.
      const roll = clamp(float(1).sub(smoothstep(0.2, 0.5, cpp)), 0, 1) as V;
      w = amp.mul(mix(float(1), roll, aa)) as V;
    }
    sum = sum.add(w.mul(base(p, pxo, pyo))) as V;
    ampSum = ampSum.add(w) as V;
    amp = amp.mul(gain) as V;
  }
  // Weighted average, but converge to the noise MEAN (0.5 for these [0,1] bases) as the surviving octave
  // weight drops below 1 — so a fully band-limited noise (every octave finer than a texel) fades to flat
  // mid-grey, never collapses to 0/black via the divide. With no rolloff, ampSum ≥ 1, so this is the average.
  return mix(float(0.5), sum.div(ampSum.max(1e-4)), min(ampSum, 1)) as V;
}
