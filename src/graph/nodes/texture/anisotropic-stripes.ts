import { atan, mx_noise_float, vec3, float } from "three/tsl";
import type { MaterialNodeDef } from "../../types";

const TAU = 6.283185307179586;

// Directional ridges that repeat around the Y axis (the angular coordinate) with vertical waviness —
// the generic version of the old bark-fibers node. Bark is one preset of it (count/sharpness/waviness);
// it is equally usable for fluting, corrugation, muscle striation, etc.
export const anisotropicStripesNode: MaterialNodeDef = {
  type: "anisotropic-stripes",
  nodeClass: "texture",
  label: "Anisotropic Stripes",
  inputs: [{ key: "coord", kind: "vector" }],
  outputs: [{ key: "field", kind: "float" }],
  params: [
    { key: "count", label: "count", type: "float", min: 1, max: 64, step: 1, default: 22 },
    { key: "sharpness", label: "sharpness", type: "float", min: 0.2, max: 8, step: 0.1, default: 2.2 },
    { key: "waviness", label: "waviness", type: "float", min: 0, max: 2, step: 0.01, default: 0.18 },
    { key: "contrast", label: "contrast", type: "float", min: 0, max: 1, step: 0.01, default: 1 },
  ],
  build(ctx) {
    const domain = ctx.inputs.coord ?? ctx.coord;
    const around = atan(domain.z, domain.x).div(TAU); // -0.5..0.5 around the trunk
    const wav = mx_noise_float(vec3(domain.y.mul(0.6), around.mul(6), float(0))).mul(ctx.uniforms.waviness);
    const phase = around.mul(ctx.uniforms.count).add(wav);
    const stripe = phase.mul(TAU).sin().mul(0.5).add(0.5);
    return { field: stripe.pow(ctx.uniforms.sharpness).mul(ctx.uniforms.contrast) };
  },
};
