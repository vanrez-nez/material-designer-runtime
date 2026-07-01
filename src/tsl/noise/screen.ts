import {
  Fn,
  floatBitsToUint,
  uint,
  int,
  float,
  vec2,
  fract,
  floor,
  dot,
  fwidth,
  sin,
  cos,
  abs,
  smoothstep,
  max,
  select,
  exp2,
} from "three/tsl";
import type { MaterialValue } from "../../graph/types";

// Screen-space / pixel dither noises (@lumiey). These are NOT tileable and are resolution-dependent — they
// operate on integer pixel indices / screen derivatives, so they're a separate node from the seamless
// Tileable Noise. Faithful ports (float-bits hashing, exactly as @lumiey). `p` is the pixel coordinate
// (uv × resolution). All return ~[0,1].
type V = MaterialValue;
const U32_MAX = 4294967295.0; // float(~0u)

// @lumiey hash12: floatBitsToUint XOR hash → [0,1).
function hash12(p: V): V {
  const u = floatBitsToUint(p.mul(vec2(141421356, 2718281828))) as V;
  return float(u.x.bitXor(u.y).mul(uint(3141592653))).div(U32_MAX) as V;
}

// Interleaved Gradient Noise — low-discrepancy over space.
export function ign12(p: V): V {
  return fract(float(52.9829189).mul(fract(dot(p, vec2(0.06711056, 0.00583715))))) as V;
}

// Golden-ratio IGN variant (integer pixel index).
export function goldenIgn12(p: V): V {
  const ux = uint(p.x);
  const uy = uint(p.y);
  return float(ux.mul(uint(3242174889)).add(uy.mul(uint(2447445413)))).mul(exp2(-32)) as V;
}

// Blue noise via a 3×3 high-pass of the white-noise hash (@lumiey blue12).
export function blue12(p: V): V {
  let v: V = float(0);
  for (let k = 0; k < 9; k++) {
    v = v.add(hash12(p.add(vec2((k % 3) - 1, Math.floor(k / 3) - 1)))) as V;
  }
  return float(0.9).mul(float(1.125).mul(hash12(p)).sub(v.div(8))).add(0.5) as V;
}

// Hilbert-curve-ordered blue noise (@lumiey hilbert_blue12). Integer Hilbert encode over a 512² grid, then a
// golden-ratio decorrelation. The loop is JS-unrolled (s = 256…1).
// Fn-wrapped so the stateful px/py/i .toVar()/.assign() sequence correctly (an inline call collapses them).
const hilbertEncode512 = Fn(([px0, py0]: V[]): V => {
  const px = px0.toVar();
  const py = py0.toVar();
  const i = int(0).toVar();
  for (let s = 256; s > 0; s >>= 1) {
    const sN = int(s);
    const rx = select(px.bitAnd(sN).notEqual(int(0)), int(1), int(0)) as V;
    const ry = select(py.bitAnd(sN).notEqual(int(0)), int(1), int(0)) as V;
    i.assign(i.add(sN.mul(sN).mul(rx.shiftLeft(1).bitOr(rx.bitXor(ry)))));
    // rotate: p ^= (p.x^p.y)*(1-ry) ^ (s-1)*(rx & (1-ry))
    const t = px
      .bitXor(py)
      .mul(int(1).sub(ry))
      .bitXor(int(s - 1).mul(rx.bitAnd(int(1).sub(ry)))) as V;
    px.assign(px.bitXor(t));
    py.assign(py.bitXor(t));
  }
  return i;
});

export function hilbertBlue12(p: V): V {
  const idx = hilbertEncode512(int(p.x), int(p.y)) as V;
  return fract(float(0.6180339887498948).mul(float(idx.mod(int(262144))))) as V;
}

// Anisotropic scratches (@lumiey scratches12). Resolution-dependent (uses fwidth); one cell hosts a thin
// rotated streak, max-combined over 8 sheared layers. Fn-wrapped for the stateful seed var.
const scratch = Fn(([uv0, f]: V[]): V => {
  const seed = floor(uv0).toVar() as V;
  let uv = uv0.sub(seed) as V;
  seed.x.assign(floor(sin(seed.x.mul(51024.0)).mul(3104.0)));
  seed.y.assign(floor(sin(seed.y.mul(1324.0)).mul(554.0)));
  const sxy = seed.x.add(seed.y) as V;
  uv = uv.mul(2).sub(1) as V;
  uv = uv.mul(cos(sxy)).add(vec2(uv.y.negate(), uv.x).mul(sin(sxy))) as V;
  uv = uv.add(sin(seed.x.sub(seed.y))) as V;
  uv = uv.mul(0.5).add(0.5) as V;
  const WAVY = 0.2;
  const s = sin(seed.x.add(uv.y.mul(3.1415))).add(sin(seed.y.add(uv.y.mul(3.1415)))).mul(WAVY) as V;
  let x = abs(uv.x.sub(0.5).add(s)) as V;
  x = float(0.5).sub(x.mul(f)) as V;
  x = smoothstep(-2.0, fwidth(x).mul(1.5).add(16.0), x).mul(12.0) as V;
  return x.mul(uv.y) as V;
});

// `thinness` controls scratch width (higher = thinner). @lumiey ties this to 1/fwidth (hairline on a
// hi-DPI screen); for a baked texture that collapses to ~invisible, so it's an explicit value here.
export function scratches12(uv0: V, thinness: V): V {
  let uv = uv0 as V;
  const f = thinness;
  let acc: V = float(0);
  for (let i = 0; i < 8; i++) {
    acc = max(acc, scratch(uv, f)) as V;
    // uv = uv * mat2(1, 0.7, -0.7, 1) - 12.31  (column-major: x' = uv.x - 0.7*uv.y, y' = 0.7*uv.x + uv.y)
    uv = vec2(uv.x.sub(uv.y.mul(0.7)), uv.x.mul(0.7).add(uv.y)).sub(12.31) as V;
  }
  return acc;
}
