import { vec3, float, select, floor, max, min } from "three/tsl";
import type { MaterialValue } from "../graph/types";

// Branchless TSL ports of Blender's rgb_to_hsv / hsv_to_rgb (gpu_shader_common_color_utils.glsl), used by
// the Hue/Saturation/Value node. The per-pixel if/elif branches become `select` (both branches evaluate;
// divisions are epsilon-guarded so the discarded inf/NaN never reaches the chosen result).
type V = MaterialValue;
const EPS = 1e-10;

export function rgbToHsv(rgb: V): V {
  const r = rgb.x;
  const g = rgb.y;
  const b = rgb.z;
  const cmax = max(r, max(g, b));
  const cmin = min(r, min(g, b));
  const cdelta = cmax.sub(cmin);
  const v = cmax;
  const s = select(cmax.equal(0), float(0), cdelta.div(max(cmax, float(EPS))));
  // c = (cmax - rgb) / cdelta (only meaningful when s != 0).
  const c = vec3(cmax, cmax, cmax).sub(rgb).div(max(cdelta, float(EPS)));
  const hR = c.z.sub(c.y);
  const hG = float(2).add(c.x).sub(c.z);
  const hB = float(4).add(c.y).sub(c.x);
  let h: V = select(g.equal(cmax), hG, hB); // else branch first
  h = select(r.equal(cmax), hR, h); // r takes priority (matches if/elif)
  h = h.div(6);
  h = select(h.lessThan(0), h.add(1), h);
  h = select(s.equal(0), float(0), h);
  return vec3(h, s, v);
}

export function hsvToRgb(hsv: V): V {
  const h0 = hsv.x;
  const s = hsv.y;
  const v = hsv.z;
  const h = select(h0.equal(1), float(0), h0).mul(6);
  const i = floor(h);
  const f = h.sub(i);
  const p = v.mul(float(1).sub(s));
  const q = v.mul(float(1).sub(s.mul(f)));
  const t = v.mul(float(1).sub(s.mul(float(1).sub(f))));
  let rgb: V = vec3(v, p, q); // i >= 5 (else)
  rgb = select(i.equal(4), vec3(t, p, v), rgb);
  rgb = select(i.equal(3), vec3(p, q, v), rgb);
  rgb = select(i.equal(2), vec3(p, v, t), rgb);
  rgb = select(i.equal(1), vec3(q, v, p), rgb);
  rgb = select(i.equal(0), vec3(v, t, p), rgb);
  return select(s.equal(0), vec3(v, v, v), rgb);
}
