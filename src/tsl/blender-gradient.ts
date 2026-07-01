import { atan, float } from "three/tsl";
import type { MaterialValue } from "../graph/types";

// Faithful TSL port of Blender's Gradient Texture (Fac output) — plan L4. Transcribed verbatim from
// gpu_shader_material_tex_gradient.glsl `calc_gradient`. Pure coordinate math (no hashing). Type is a
// build-time select. Verified against a pure-JS port of the same function.
type V = MaterialValue;
const TAU = Math.PI * 2;

// 0 linear, 1 quadratic, 2 easing, 3 diagonal, 4 radial, 5 quadratic sphere, 6 sphere.
export function blenderGradient(p: V, type: number): V {
  const x = p.x;
  const y = p.y;
  const z = p.z;
  let f: V;
  switch (type) {
    case 1: {
      const r = x.max(0);
      f = r.mul(r);
      break;
    }
    case 2: {
      const r = x.clamp(0, 1);
      const t = r.mul(r);
      f = t.mul(3).sub(t.mul(r).mul(2)); // 3t² - 2t³
      break;
    }
    case 3:
      f = x.add(y).mul(0.5);
      break;
    case 4:
      f = atan(y, x).div(TAU).add(0.5);
      break;
    case 5: {
      const r = float(0.999999).sub(x.mul(x).add(y.mul(y)).add(z.mul(z)).sqrt()).max(0);
      f = r.mul(r);
      break;
    }
    case 6:
      f = float(0.999999).sub(x.mul(x).add(y.mul(y)).add(z.mul(z)).sqrt()).max(0);
      break;
    default:
      f = x; // 0 linear
  }
  return f.clamp(0, 1);
}
