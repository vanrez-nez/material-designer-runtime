import { Fn, float, int, vec2, floor, cos, sin, exp, dot, mix, step } from "three/tsl";
import type { MaterialValue } from "../../graph/types";
import { hashCell2ToVec3Seed } from "./hash";

// Blender Gabor Texture (ShaderNodeTexGabor, 2D value), ported faithfully and made SEAMLESS. This is SPARSE
// GABOR CONVOLUTION (Lagae et al.), NOT the old per-cell plane-wave blend: over a 3×3 cell neighbourhood each
// cell scatters IMPULSES_COUNT Poisson impulses; each impulse is a Hann-windowed Gaussian kernel modulated by
// a complex phasor at 2π·frequency along a per-impulse direction. The Value output is the summed phasor's
// imaginary part (Σ weight·envelope·sin(angle)) normalised by 6σ (σ² = IMPULSES·0.5·0.25 → σ = 1). Orientation
// is the base angle blended with a per-impulse random by `isotropy` (= 1 − Anisotropy: 0 → every impulse keeps
// the base orientation = fully directional; 1 → fully random = omnidirectional). Ref (verbatim source of the
// kernel/cell/grid math): Blender `source/blender/gpu/shaders/material/gpu_shader_material_tex_gabor.glsl`.
//
// Seamless: Blender's version is non-tiling (hashes the raw cell index); here the per-cell hash wraps the
// integer cell index mod `period` (see hash.ts wrapAxis), so the offline tile edge repeats exactly. We use the
// lib's PCG3D hash rather than Blender's, so the RNG pattern differs but the algorithm/statistics are identical.
type V = MaterialValue;
const TAU = 6.283185307179586;
const PI = Math.PI;
const IMPULSES = 8; // Blender IMPULSES_COUNT

// gaborValue2D(uv, period, frequency, isotropy, orientation) → Value in ~[0,1]. `uv` is the [0,1] tile coord;
// `period` (= the noise's integer scale) sets the cell count; frequency/isotropy/orientation are live uniforms.
export const gaborValue2D = Fn(([uv, period, frequency, isotropy, orientation]: V[]): V => {
  const coords = uv.mul(period) as V;
  const cell = floor(coords) as V;
  const local = coords.sub(cell) as V;
  const sum = float(0).toVar(); // Σ of the phasor's imaginary (sin) part — the Value output needs only this
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = int(cell.x).add(i) as V; // integer cell index (wrapped mod period inside the hash → seamless)
      const cy = int(cell.y).add(j) as V;
      const pcs = local.sub(vec2(i, j)) as V; // position in this cell's local space
      for (let k = 0; k < IMPULSES; k++) {
        // Per-impulse randoms: one PCG3D vec3 gives kernel centre (xy) + Bernoulli weight (z); a second seed
        // gives the orientation jitter. (Blender uses 3 separate hashes; the exact RNG differs regardless.)
        const hA = hashCell2ToVec3Seed(cx, cy, k * 2, period, period);
        const hB = hashCell2ToVec3Seed(cx, cy, k * 2 + 1, period, period);
        const orient = orientation.add(hB.x.sub(0.5).mul(PI).mul(isotropy)) as V;
        const pks = pcs.sub(vec2(hA.x, hA.y)) as V; // position relative to this impulse's kernel centre
        const d2 = dot(pks, pks) as V;
        // Windowed Gaussian envelope: exp(−π·d²) × Hann(0.5 + 0.5·cos(π·d²)); support is the unit disk.
        const env = exp(d2.mul(-PI)).mul(float(0.5).add(cos(d2.mul(PI)).mul(0.5))) as V;
        const angle = dot(pks, vec2(cos(orient), sin(orient)).mul(frequency)).mul(TAU) as V;
        const weight = mix(float(-1), float(1), step(0.5, hA.z)); // Bernoulli ±1
        const inside = float(1).sub(step(1.0, d2)); // 1 while d² < 1, else 0 (kernel support cutoff)
        sum.addAssign(sin(angle).mul(env).mul(weight).mul(inside));
      }
    }
  }
  // Value = (Σ_imag / 6σ)·0.5 + 0.5, σ = sqrt(IMPULSES·0.5·0.25) = 1. Blender doesn't clamp; ~99.7% ∈ [0,1].
  return sum.div(6).mul(0.5).add(0.5);
});
