import { vec2, float, clamp } from "three/tsl";
import type { MaterialValue } from "../../graph/types";
import { pnoise2 } from "../tileable-noise";
import { curlVec2 } from "./flow";

// Erosion-style noise (representative periodic variant of @lumiey erosion12). The faithful original is a
// multi-pass "gullies" accumulation on Perlin derivatives; a fully periodic multi-pass port is high-risk, so
// this is a representative seamless approximation with the same read: the periodic curl flow warps the domain
// (carving directional channels), and a ridge transform of the warped periodic Perlin yields gully ridges.
// Builds only on periodic primitives, so it tiles. `p` is period-scaled; `per` the (square) period. [0,1].
type V = MaterialValue;

export function erosionBase01(p: V, per: number, _perY: number): V {
  const flow = curlVec2(p, per) as V;
  const q = p.add(flow.mul(0.6)) as V; // warp the domain along the flow → directional channels
  const h = pnoise2(q, vec2(per, per)).mul(0.5).add(0.5) as V; // periodic Perlin, [0,1]
  // Ridge transform: 1 - |2h-1| concentrates value into sharp crests between the carved channels.
  return clamp(float(1).sub(h.mul(2).sub(1).abs()), 0, 1) as V;
}
