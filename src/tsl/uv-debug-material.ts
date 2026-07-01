import { DoubleSide } from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { uv, vec3, mix, mod, floor } from "three/tsl";

// UV checker debug visualiser, rebuilt in TSL (the old ShaderMaterial GLSL path cannot run under
// WebGPURenderer). R = u, G = v gradient, with alternating darkened squares to reveal seams/tiling.
export function createUvDebugMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  const uvN = uv();
  const checker = mod(floor(uvN.x.mul(16)).add(floor(uvN.y.mul(16))), 2);
  const grad = vec3(uvN.x, uvN.y, 0);
  material.colorNode = mix(grad.mul(0.45), grad, checker);

  return material;
}
