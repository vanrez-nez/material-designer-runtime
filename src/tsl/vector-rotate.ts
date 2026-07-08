import { vec3, cos, sin } from "three/tsl";
import type { MaterialValue } from "../graph/types";

// Rotate a vector about a single principal axis — the axis-mode subset of Blender's ShaderNodeVectorRotate
// (euler / free-axis-angle modes are not needed by the current material set and can be added later). `angle`
// is in radians and may be a per-fragment field, so each fragment (or, fed a per-cell random, each cell) can
// rotate by its own amount. Pure transform: it owns no lattice, so it never affects tiling seamlessness —
// that is governed entirely by its inputs.
type V = MaterialValue;

// axis: 0 = X, 1 = Y, 2 = Z. Rotates `v` around `center` by `angle` (CCW in the plane of the other two axes).
export function rotateAxis(v: V, center: V, angle: V, axis: number): V {
  const p = v.sub(center) as V;
  const c = cos(angle) as V;
  const s = sin(angle) as V;
  let rx: V, ry: V, rz: V;
  if (axis === 0) {
    // about X → rotate the (y, z) plane
    rx = p.x;
    ry = c.mul(p.y).sub(s.mul(p.z));
    rz = s.mul(p.y).add(c.mul(p.z));
  } else if (axis === 1) {
    // about Y → rotate the (z, x) plane
    ry = p.y;
    rz = c.mul(p.z).sub(s.mul(p.x));
    rx = s.mul(p.z).add(c.mul(p.x));
  } else {
    // about Z → rotate the (x, y) plane (2D texture rotation)
    rz = p.z;
    rx = c.mul(p.x).sub(s.mul(p.y));
    ry = s.mul(p.x).add(c.mul(p.y));
  }
  return center.add(vec3(rx, ry, rz)) as V;
}
