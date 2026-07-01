import { float, int, floor, mix } from "three/tsl";
import type { MaterialValue } from "../../graph/types";
import { hashCell2 } from "./hash";

// Periodic value noise (@lumiey `value12`, made seamless): hash the four corner cells of `floor(p)`,
// smoothstep-interpolate. The corner indices are wrapped to (perX, perY) inside hashCell2, so the field
// tiles. `p` is the already period-scaled coordinate (floor(p) = lattice cells). Returns [0,1].
type V = MaterialValue;

export function valueBase01(p: V, perX: number, perY: number): V {
  const i = floor(p) as V;
  const f = p.sub(i) as V;
  const u = f.mul(f).mul(float(3).sub(f.mul(2))) as V; // smoothstep weights
  const ix = int(i.x);
  const iy = int(i.y);
  const h00 = hashCell2(ix, iy, perX, perY);
  const h10 = hashCell2(ix.add(1), iy, perX, perY);
  const h01 = hashCell2(ix, iy.add(1), perX, perY);
  const h11 = hashCell2(ix.add(1), iy.add(1), perX, perY);
  return mix(mix(h00, h10, u.x), mix(h01, h11, u.x), u.y);
}
