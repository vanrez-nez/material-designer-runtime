import { vec3, float } from "three/tsl";
import type { MaterialBundle, MaterialNodeDef, MaterialValue } from "../../types";

// Emission shader — a pure emitter (Blender's Emission node). Like Principled it emits the constrained
// green Shader marker (a MaterialBundle) that only Material Output consumes. Maps to an emissive-only
// MeshPhysicalNodeMaterial: black base, full roughness, emission = colour × strength.
export const emissionNode: MaterialNodeDef = {
  type: "emission",
  nodeClass: "shader",
  label: "Emission",
  inputs: [
    { key: "color", label: "Color", kind: "color" },
    { key: "strength", label: "Strength", kind: "float" },
  ],
  outputs: [{ key: "bsdf", kind: "shader" }],
  params: [
    { key: "color", label: "color", type: "color", default: "#ffffff" },
    { key: "strength", label: "strength", type: "float", min: 0, max: 10, step: 0.1, default: 1 },
  ],
  build(ctx): Record<string, MaterialValue> {
    const color = ctx.inputs.color ?? ctx.uniforms.color;
    const strength = ctx.inputs.strength ?? ctx.uniforms.strength;
    const bundle: MaterialBundle = {
      baseColor: vec3(0),
      roughness: float(1),
      metallic: float(0),
      emission: color.mul(strength),
    };
    return { bsdf: bundle };
  },
};
