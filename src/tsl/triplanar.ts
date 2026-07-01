import { Fn, vec3, pow, texture, positionWorld, normalWorld } from "three/tsl";
import type { Texture } from "three/webgpu";
import type { MaterialValue } from "../graph/types";

// Triplanar projection blend weights with a SHARPNESS exponent. The built-in triplanarTexture blends the
// three planar projections linearly (`abs(normal)` normalized), which leaves a wide band on ~45° faces
// where two projections average — very visible on high-contrast patterns (a checker washes to pale). Raising
// `abs(normal)` to a power makes the dominant axis win, shrinking that band to a thin transition.
type V = MaterialValue;

export function triplanarBlendWeights(sharpness: V): V {
  const bf = pow(normalWorld.abs() as V, sharpness) as V;
  return bf.div(bf.dot(vec3(1, 1, 1)).max(1e-4));
}

// Sharpened triplanar texture sample (vec4). Drop-in for triplanarTexture but with the sharpness weights.
export function triplanarColor(map: Texture, scale: V, sharpness: V): V {
  return Fn(() => {
    const p = positionWorld.mul(scale) as V;
    const bf = triplanarBlendWeights(sharpness);
    const cx = texture(map, p.yz).mul(bf.x);
    const cy = texture(map, p.zx).mul(bf.y);
    const cz = texture(map, p.xy).mul(bf.z);
    return cx.add(cy).add(cz);
  })();
}
