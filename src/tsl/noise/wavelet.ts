import { int, floor, fract, sin, cos, dot, vec2, smoothstep, clamp } from "three/tsl";
import type { MaterialValue } from "../../graph/types";
import { hashCell2 } from "./hash";

// Periodic wavelet noise (@lumiey wavelet12, made seamless). The original stacks octaves with a free random
// rotation per octave, which breaks periodicity. Here each cell hosts a single oriented wisp confined to the
// cell (its radial window falls to 0 at the cell edge), so neighbouring cells meet at 0 → the field tiles;
// the cell orientation comes from the WRAPPED cell hash. The node's `octaves` stack scaled copies (the
// periodic-fBm replacement for the original inter-octave rotation). `p` is period-scaled; perX/perY periods.
// [0,1].
type V = MaterialValue;
const TAU = 6.283185307179586;

export function waveletBase01(p: V, perX: number, perY: number): V {
  const i = floor(p) as V;
  const f = fract(p).sub(0.5) as V; // cell-local coord in [-0.5, 0.5]
  const a = hashCell2(int(i.x), int(i.y), perX, perY).mul(TAU) as V; // cell orientation
  const ca = cos(a) as V;
  const sa = sin(a) as V;
  const qx = ca.mul(f.x).sub(sa.mul(f.y)) as V; // rotate f by a
  const qy = sa.mul(f.x).add(ca.mul(f.y)) as V;
  const window = smoothstep(0.25, 0, dot(vec2(qx, qy), vec2(qx, qy))) as V; // 0 at the cell edge → seamless
  const d = sin(qx.mul(10)).mul(window) as V;
  return clamp(d.mul(0.5).add(0.5), 0, 1) as V;
}
