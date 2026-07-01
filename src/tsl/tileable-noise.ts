import { Fn, vec2, vec4, floor, fract, mod, abs, dot, mix, float, fwidth, smoothstep, clamp, max, min } from "three/tsl";
import type { MaterialValue } from "../graph/types";

// Tileable 2D noise via Gustavson's periodic classic Perlin ("pnoise", webgl-noise, MIT). `mod(Pi, rep)`
// wraps the integer lattice, so the noise tiles EXACTLY with period `rep`. Chosen over psrdnoise (simplex)
// because we don't need its analytic gradient here — the offline normal is dFdx/dFdy of the (now tileable)
// height, which tiles for free. This is the native, non-Blender tiling primitive for offline textures.
type V = MaterialValue;

const permute = (x: V): V => mod(x.mul(34).add(1).mul(x), 289) as V;
const fade = (t: V): V => t.mul(t).mul(t).mul(t.mul(t.mul(6).sub(15)).add(10)) as V;

// Periodic Perlin noise at P with integer period `rep` (vec2). Returns ~[-1, 1].
export const pnoise2 = Fn(([P, rep]: V[]): V => {
  const Pi0 = floor(P.xyxy).add(vec4(0, 0, 1, 1)) as V;
  const Pf = fract(P.xyxy).sub(vec4(0, 0, 1, 1)) as V;
  const Pi = mod(mod(Pi0, rep.xyxy), 289) as V; // periodic wrap, then keep the hash in range
  const ix = Pi.xzxz;
  const iy = Pi.yyww;
  const fx = Pf.xzxz;
  const fy = Pf.yyww;
  const i = permute(permute(ix).add(iy));
  const gx0 = fract(i.mul(0.0243902439)).mul(2).sub(1) as V; // 1/41
  const gy = abs(gx0).sub(0.5) as V;
  const gx = gx0.sub(floor(gx0.add(0.5))) as V;
  let g00 = vec2(gx.x, gy.x) as V;
  let g10 = vec2(gx.y, gy.y) as V;
  let g01 = vec2(gx.z, gy.z) as V;
  let g11 = vec2(gx.w, gy.w) as V;
  const norm = float(1.79284291400159).sub(
    float(0.85373472095314).mul(vec4(dot(g00, g00), dot(g01, g01), dot(g10, g10), dot(g11, g11))),
  ) as V;
  g00 = g00.mul(norm.x);
  g01 = g01.mul(norm.y);
  g10 = g10.mul(norm.z);
  g11 = g11.mul(norm.w);
  const n00 = dot(g00, vec2(fx.x, fy.x));
  const n10 = dot(g10, vec2(fx.y, fy.y));
  const n01 = dot(g01, vec2(fx.z, fy.z));
  const n11 = dot(g11, vec2(fx.w, fy.w));
  const fadexy = fade(Pf.xy) as V;
  const n_x = mix(vec2(n00, n01), vec2(n10, n11), fadexy.x) as V;
  return mix(n_x.x, n_x.y, fadexy.y).mul(2.3);
});

// Tileable fBm over uv ∈ [0,1]. Octave i samples at frequency 2^i with period (periodX,periodY)·2^i — all
// integer, so every octave (and their sum) tiles seamlessly over [0,1]. periodX/Y are the base detail per
// axis (anisotropy). `octaves` is a build-time count (loop unroll); `gain` a live uniform. Returns ~[-1,1].
export function tileableFbm(
  uv2: V, // the 2D coordinate (uv tile)
  periodX: number | V,
  periodY: number | V,
  octaves: number,
  gain: V,
  // Optional anti-alias strength (0..1); see periodicFbm01. Fades octaves finer than the bake texel grid so
  // the sum never carries frequencies the texture can't represent (which alias into speckle). Undefined = off.
  aa?: V,
  // Per-octave period multiplier — MUST be whole (integer octave periods keep the tile seamless). Default 2.
  lacunarity = 2,
): V {
  // periodX/Y may be JS numbers (build-time) or uniform nodes (a live `scale` that re-renders without
  // recompiling). Coerce to nodes so the octave scaling is node math either way; numeric periods are
  // rounded/clamped, uniform ones are expected already integer (rounded in-shader by the caller) so it tiles.
  const px: V = typeof periodX === "number" ? float(Math.max(1, Math.round(periodX))) : periodX;
  const py: V = typeof periodY === "number" ? float(Math.max(1, Math.round(periodY))) : periodY;
  const fw: V = fwidth(uv2); // uv change per bake texel (supersampling + any upstream warp)
  let sum: V = float(0);
  let ampSum: V = float(0);
  let amp: V = float(1);
  const lac = Math.max(2, Math.round(lacunarity));
  for (let o = 0; o < Math.max(1, octaves); o++) {
    const f = Math.round(Math.pow(lac, o)); // lacunarity^o (integer keeps octave periods whole → tiles)
    const rep = vec2(px.mul(f), py.mul(f)) as V;
    // Fade this octave once its cells drop below the texel grid (see periodicFbm01); weight sum + ampSum.
    let w: V = amp;
    if (aa !== undefined) {
      const cpp = max(rep.x.mul(fw.x), rep.y.mul(fw.y)) as V;
      // See periodicFbm01: fade from ~5 texels/cell to gone at ~2 (the sampling limit), so octaves that
      // would alias into per-texel speckle through Normal From Height are removed, coherent ones kept.
      const roll = clamp(float(1).sub(smoothstep(0.2, 0.5, cpp)), 0, 1) as V;
      w = amp.mul(mix(float(1), roll, aa)) as V;
    }
    sum = sum.add(w.mul(pnoise2(uv2.mul(rep), rep))) as V;
    ampSum = ampSum.add(w) as V;
    amp = amp.mul(gain) as V;
  }
  // Weighted average, converging to the pnoise MEAN (0) as surviving octave weight drops below 1, so a fully
  // band-limited noise fades to flat (→ 0.5 after the caller's ·0.5+0.5) instead of collapsing via the divide.
  // With no rolloff ampSum ≥ 1, so this reduces to the plain average.
  return mix(float(0), sum.div(ampSum.max(1e-4)), min(ampSum, 1)) as V;
}
