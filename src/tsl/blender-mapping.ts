import { vec3, sin, cos } from "three/tsl";
import type { MaterialValue } from "../graph/types";

// Faithful TSL port of Blender's Mapping node — plan §4 (Vector family). Transcribed from
// gpu_shader_material_mapping.glsl (mapping_point/texture/vector/normal) with the XYZ Euler→matrix from
// Blender's eul_to_mat3. `rotation` is in radians. Verified against a pure-JS port of the same math.
type V = MaterialValue;

// The 9 entries of from_rotation(EulerXYZ(rot)), Blender's column-major mat[col][row] (eul_to_mat3, XYZ).
function eulerMat(rot: V) {
  const ci = cos(rot.x) as V;
  const cj = cos(rot.y) as V;
  const ch = cos(rot.z) as V;
  const si = sin(rot.x) as V;
  const sj = sin(rot.y) as V;
  const sh = sin(rot.z) as V;
  const cc = ci.mul(ch);
  const cs = ci.mul(sh);
  const sc = si.mul(ch);
  const ss = si.mul(sh);
  return {
    m00: cj.mul(ch),
    m10: sj.mul(sc).sub(cs),
    m20: sj.mul(cc).add(ss),
    m01: cj.mul(sh),
    m11: sj.mul(ss).add(cc),
    m21: sj.mul(cs).sub(sc),
    m02: sj.negate(),
    m12: cj.mul(si),
    m22: cj.mul(ci),
  };
}

// M * v  (result[row] = Σ_col mat[col][row] * v[col]).
function mul(m: ReturnType<typeof eulerMat>, v: V): V {
  return vec3(
    m.m00.mul(v.x).add(m.m10.mul(v.y)).add(m.m20.mul(v.z)),
    m.m01.mul(v.x).add(m.m11.mul(v.y)).add(m.m21.mul(v.z)),
    m.m02.mul(v.x).add(m.m12.mul(v.y)).add(m.m22.mul(v.z)),
  );
}

// Mᵀ * v (inverse rotation; result[row] = Σ_col mat[row][col] * v[col]).
function mulT(m: ReturnType<typeof eulerMat>, v: V): V {
  return vec3(
    m.m00.mul(v.x).add(m.m01.mul(v.y)).add(m.m02.mul(v.z)),
    m.m10.mul(v.x).add(m.m11.mul(v.y)).add(m.m12.mul(v.z)),
    m.m20.mul(v.x).add(m.m21.mul(v.y)).add(m.m22.mul(v.z)),
  );
}

// 0 point, 1 texture, 2 vector, 3 normal. (scale is assumed non-zero — Blender uses safe_divide.)
export function blenderMapping(v: V, location: V, rotation: V, scale: V, type: number): V {
  const m = eulerMat(rotation);
  if (type === 1) return mulT(m, v.sub(location)).div(scale); // texture (inverse)
  if (type === 2) return mul(m, v.mul(scale)); // vector (no location)
  if (type === 3) return mul(m, v.div(scale)).normalize(); // normal
  return mul(m, v.mul(scale)).add(location); // point (default)
}
