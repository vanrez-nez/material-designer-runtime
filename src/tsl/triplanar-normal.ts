import { Fn, vec3, texture, positionWorld, normalWorld } from "three/tsl";
import type { Texture } from "three/webgpu";
import type { MaterialValue } from "../graph/types";
import { triplanarBlendWeights } from "./triplanar";

// Triplanar sampling for a TANGENT-SPACE normal map (the offline backend's baked normal). TSL's built-in
// `triplanarTexture` only value-blends, which is wrong for normals — each plane's tangent-space normal must
// be reoriented into world space before blending. This is the "whiteout"/swizzle technique (Ben Golus).
//
// Plane convention matches three's triplanarTexture: X-plane samples world .yz, Y-plane .zx, Z-plane .xy.
// For a decoded tangent normal n = (u, v, up): X-plane → world n.zxy, Y-plane → world n.yzx, Z-plane → n.xyz.
// The `up` component is flipped by the sign of the geometry world normal so back-facing planes don't invert.
// Weights are |worldNormal| normalized, same as triplanarTexture.
type V = MaterialValue;

export function triplanarNormalMap(map: Texture, scale: V, sharpness: V): V {
  return Fn(() => {
    const p = positionWorld.mul(scale);
    const bf = triplanarBlendWeights(sharpness); // sharpened weights (shared with the colour sampler)
    const s = normalWorld.sign();

    // Decode each plane's tangent-space normal to [-1, 1].
    const nx = texture(map, p.yz).xyz.mul(2).sub(1) as V;
    const ny = texture(map, p.zx).xyz.mul(2).sub(1) as V;
    const nz = texture(map, p.xy).xyz.mul(2).sub(1) as V;

    // Flip the surface-out (z) component by the geometry-normal sign, then swizzle into world space.
    const NX = vec3(nx.x, nx.y, nx.z.mul(s.x));
    const NY = vec3(ny.x, ny.y, ny.z.mul(s.y));
    const NZ = vec3(nz.x, nz.y, nz.z.mul(s.z));

    const world = NX.zxy
      .mul(bf.x)
      .add(NY.yzx.mul(bf.y))
      .add(NZ.xyz.mul(bf.z));
    return world.normalize();
  })();
}
