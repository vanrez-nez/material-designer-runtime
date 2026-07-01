import { floor, select } from "three/tsl";
import type { MaterialValue } from "../graph/types";

// Catmull-Rom spline through 5 control points at uniform x = 0, .25, .5, .75, 1 (endpoints clamped).
// Used by the RGB Curves node as a grounded stand-in for Blender's full CurveMapping (movable-handle,
// per-channel, baked-LUT) — a smooth editable tone curve, not a bit-exact match to Blender's model.
type V = MaterialValue;

const sel4 = (seg: V, a: V, b: V, c: V, d: V): V =>
  select(seg.equal(0), a, select(seg.equal(1), b, select(seg.equal(2), c, d)));

// Evaluate the curve at t ∈ [0,1]. p = [p0..p4] (the control-point y values).
export function curve5(t: V, p: V[]): V {
  const x = t.clamp(0, 1).mul(4);
  const seg = floor(x).clamp(0, 3);
  const s = x.sub(seg);
  // 4-point window per segment, with the ends duplicated (clamped).
  const A = sel4(seg, p[0], p[0], p[1], p[2]);
  const B = sel4(seg, p[0], p[1], p[2], p[3]);
  const C = sel4(seg, p[1], p[2], p[3], p[4]);
  const D = sel4(seg, p[2], p[3], p[4], p[4]);
  const s2 = s.mul(s);
  const s3 = s2.mul(s);
  // 0.5 * (2B + (C−A)s + (2A−5B+4C−D)s² + (3B−3C+D−A)s³)
  return B.mul(2)
    .add(C.sub(A).mul(s))
    .add(A.mul(2).sub(B.mul(5)).add(C.mul(4)).sub(D).mul(s2))
    .add(B.mul(3).sub(C.mul(3)).add(D).sub(A).mul(s3))
    .mul(0.5);
}
