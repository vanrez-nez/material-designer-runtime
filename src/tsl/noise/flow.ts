import { Fn, vec2, vec3, float, clamp, max, abs } from "three/tsl";
import type { MaterialValue } from "../../graph/types";
import { pnoise2 } from "../tileable-noise";

// Curl-flow family (@lumiey curl/paper/stone/wool), made seamless by using the PERIODIC Perlin `pnoise2`
// (tileable-noise.ts) as the underlying potential — every sample wraps at the integer period, so the derived
// flow field tiles too. Bases take the period-scaled coord `p` and the (square) period; cellular/flow types
// ignore aspect. pnoise2 returns ~[-1,1].
type V = MaterialValue;

// Periodic perlin scalar at p with period `per` (square).
const pn = (p: V, per: number): V => pnoise2(p, vec2(per, per));

// 2D curl-like flow via central differences of the periodic Perlin field (faithful to @lumiey curl22).
// Returns the raw vec2 flow (unbounded-ish, ~[-1,1] scale). Wrapped in Fn so the pnoise2 calls sequence.
export const curlVec2 = Fn(([p, per]: V[]): V => {
  const e = float(0.1);
  const ax = pn(p.add(vec2(e, 0)), per);
  const ay = pn(p.add(vec2(0, e)), per);
  const bx = pn(p.sub(vec2(e, 0)), per);
  const by = pn(p.sub(vec2(0, e)), per);
  return vec2(ax.sub(bx), ay.sub(by)).div(e).mul(0.5);
});

// Curl as a graph `vector` output (z = 0).
export function curlVec(p: V, per: number, _perY: number): V {
  const c = curlVec2(p, per) as V;
  return vec3(c.x, c.y, float(0));
}

// Paper (@lumiey paper12): magnitude of the curl flow → fibrous field. [0,1].
export function paperBase01(p: V, per: number, _perY: number): V {
  const c = curlVec2(p, per) as V;
  return clamp(c.length().mul(0.6).add(0.2), 0, 1) as V;
}

// Wool (@lumiey wool12): max(|cx|,|cy|) of the curl flow. [0,1].
export function woolBase01(p: V, per: number, _perY: number): V {
  const c = curlVec2(p, per) as V;
  return clamp(max(abs(c.x), abs(c.y)), 0, 1) as V;
}

// Stone (@lumiey stone12): Perlin domain-warped by the curl flow → veined stone. [0,1].
export function stoneBase01(p: V, per: number, _perY: number): V {
  const warp = curlVec2(p, per).mul(0.4) as V;
  return pn(p.add(warp), per).mul(0.5).add(0.5) as V;
}
