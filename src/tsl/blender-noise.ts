import { Fn, float, int, uint, floor, select } from "three/tsl";
import type { MaterialValue } from "../graph/types";

// Faithful TSL port of Blender's Perlin noise + fBm (plan L4 / decision 2). Transcribed verbatim from
// Blender's GPU shader sources:
//   - hash:   gpu_shader_common_hash.glsl        — hash_uint3 + the `final` bit-mix macro
//   - perlin: gpu_shader_material_noise.glsl      — fade, noise_grad, tri_mix, noise_perlin,
//                                                   snoise = noise_scale3 (0.9820) * noise_perlin
//   - fbm:    gpu_shader_material_fractal_noise.glsl — noise_fbm, normalize = 0.5*sum/maxamp + 0.5
// Verified against Blender via the dual-system bake (scripts/blender_bake.py).
//
// Caveats (surfaced, not hidden):
//   - snoise's precision-correction + compatible_mod(p, 1e5) is omitted: valid for our coord domains
//     (baked uv in [0,1], modest world coords).
//   - Integer cell coords stay non-negative in the baked uv domain, so uint(int) reinterpretation
//     matches GLSL there; the faithful MATCH is checked in that domain. Very negative live world coords
//     are out of scope for the exact match (the live noise is still valid Perlin).

type V = MaterialValue;

// rot(x, k): 32-bit left rotate.
const rot = (x: V, k: number): V => x.shiftLeft(k).bitOr(x.shiftRight(32 - k));

// hash_uint3 → uint. a/b/c are GPU vars (toVar) so the sequential bit-mix doesn't expand into a
// duplicated expression tree.
function hashUint3(kx: V, ky: V, kz: V): V {
  const seed = 0xdeadbeef + (3 << 2) + 13; // 0xdeadbeef + 25
  const a = uint(seed).toVar();
  const b = uint(seed).toVar();
  const c = uint(seed).toVar();
  c.assign(c.add(kz));
  b.assign(b.add(ky));
  a.assign(a.add(kx));
  // final(a, b, c)
  c.assign(c.bitXor(b)); c.assign(c.sub(rot(b, 14)));
  a.assign(a.bitXor(c)); a.assign(a.sub(rot(c, 11)));
  b.assign(b.bitXor(a)); b.assign(b.sub(rot(a, 25)));
  c.assign(c.bitXor(b)); c.assign(c.sub(rot(b, 16)));
  a.assign(a.bitXor(c)); a.assign(a.sub(rot(c, 4)));
  b.assign(b.bitXor(a)); b.assign(b.sub(rot(a, 14)));
  c.assign(c.bitXor(b)); c.assign(c.sub(rot(b, 24)));
  return c;
}

const hashInt3 = (x: V, y: V, z: V): V => hashUint3(uint(x), uint(y), uint(z));

const fade = (t: V): V => t.mul(t).mul(t).mul(t.mul(t.mul(6).sub(15)).add(10));

const negateIf = (val: V, cond: V): V => select(cond.notEqual(uint(0)), val.negate(), val);

function noiseGrad(h: V, x: V, y: V, z: V): V {
  const hh = h.bitAnd(uint(15)).toVar();
  const u = select(hh.lessThan(uint(8)), x, y);
  const vt = select(hh.equal(uint(12)).or(hh.equal(uint(14))), x, z);
  const v = select(hh.lessThan(uint(4)), y, vt);
  return negateIf(u, hh.bitAnd(uint(1))).add(negateIf(v, hh.bitAnd(uint(2))));
}

function triMix(c: V[], x: V, y: V, z: V): V {
  const x1 = float(1).sub(x);
  const y1 = float(1).sub(y);
  const z1 = float(1).sub(z);
  return z1
    .mul(y1.mul(c[0].mul(x1).add(c[1].mul(x))).add(y.mul(c[2].mul(x1).add(c[3].mul(x)))))
    .add(z.mul(y1.mul(c[4].mul(x1).add(c[5].mul(x))).add(y.mul(c[6].mul(x1).add(c[7].mul(x))))));
}

function noisePerlin(p: V): V {
  const xf = floor(p.x).toVar();
  const yf = floor(p.y).toVar();
  const zf = floor(p.z).toVar();
  const fx = p.x.sub(xf).toVar();
  const fy = p.y.sub(yf).toVar();
  const fz = p.z.sub(zf).toVar();
  const xi = int(xf);
  const yi = int(yf);
  const zi = int(zf);
  const u = fade(fx);
  const v = fade(fy);
  const w = fade(fz);
  const g = (dx: number, dy: number, dz: number): V =>
    noiseGrad(hashInt3(xi.add(dx), yi.add(dy), zi.add(dz)), fx.sub(dx), fy.sub(dy), fz.sub(dz));
  return triMix(
    [g(0, 0, 0), g(1, 0, 0), g(0, 1, 0), g(1, 1, 0), g(0, 0, 1), g(1, 0, 1), g(0, 1, 1), g(1, 1, 1)],
    u,
    v,
    w,
  );
}

// snoise = noise_scale3 * noise_perlin.
export const blenderSnoise = (p: V): V => noisePerlin(p).mul(0.982);

// noise_fbm with normalize=true (the Noise node's Fac output). `octaves` is a build-time integer (loop
// bound — WebGPU caveat); roughness/lacunarity are live uniforms. Integer detail ⇒ no fractional octave.
//
// Wrapped in Fn(): the octave accumulation (and every hash's bit-mix) mutate `toVar` locals via
// `.assign()`, which are only captured inside a TSL function stack — at top-level graph build they'd be
// dropped, leaving maxamp=0 → sum/0 = NaN.
export function blenderFbm(p: V, octaves: number, roughness: V, lacunarity: V): V {
  const n = Math.max(0, Math.min(15, Math.floor(octaves)));
  return Fn(() => {
    const amp = float(1).toVar();
    const fscale = float(1).toVar();
    const sum = float(0).toVar();
    const maxamp = float(0).toVar();
    for (let i = 0; i <= n; i++) {
      sum.assign(sum.add(blenderSnoise(p.mul(fscale)).mul(amp)));
      maxamp.assign(maxamp.add(amp));
      amp.assign(amp.mul(roughness));
      fscale.assign(fscale.mul(lacunarity));
    }
    return sum.div(maxamp).mul(0.5).add(0.5);
  })();
}
