import { vec3, mix } from "three/tsl";
import type { MaterialNodeDef } from "../../types";

// Invert Color (Blender ShaderNodeInvert): out = mix(color, 1 - color, fac). Faithful (trivial).
export const invertNode: MaterialNodeDef = {
  type: "invert",
  nodeClass: "color",
  label: "Invert Color",
  inputs: [
    { key: "fac", label: "Fac", kind: "float" },
    { key: "color", label: "Color", kind: "color" },
  ],
  outputs: [{ key: "color", kind: "color" }],
  params: [{ key: "fac", label: "fac", type: "float", min: 0, max: 1, step: 0.01, default: 1 }],
  build(ctx) {
    const col = ctx.inputs.color ?? vec3(0, 0, 0);
    const fac = ctx.inputs.fac ?? ctx.uniforms.fac;
    return { color: mix(col, vec3(1, 1, 1).sub(col), fac) };
  },
};
