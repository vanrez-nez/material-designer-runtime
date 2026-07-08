import { vec3 } from "three/tsl";
import type { MaterialNodeDef } from "../../types";

// Separate XYZ (Blender ShaderNodeSeparateXYZ): vector → x, y, z floats.
export const separateXyzNode: MaterialNodeDef = {
  type: "separate-xyz",
  nodeClass: "converter",
  label: "Separate XYZ",
  inputs: [{ key: "vector", kind: "vector" }],
  outputs: [
    { key: "x", kind: "float" },
    { key: "y", kind: "float" },
    { key: "z", kind: "float" },
  ],
  params: [],
  build(ctx) {
    const v = ctx.inputs.vector ?? vec3(0, 0, 0);
    return { x: v.x, y: v.y, z: v.z };
  },
};

// Combine XYZ (Blender ShaderNodeCombineXYZ): x, y, z floats → vector. The key vector constructor for
// building coordinates (e.g. to feed Mapping or a texture's coord).
export const combineXyzNode: MaterialNodeDef = {
  type: "combine-xyz",
  nodeClass: "converter",
  label: "Combine XYZ",
  inputs: [
    { key: "x", kind: "float" },
    { key: "y", kind: "float" },
    { key: "z", kind: "float" },
  ],
  outputs: [{ key: "vector", kind: "vector" }],
  params: [
    { key: "x", label: "x", type: "float", min: -10, max: 10, step: 0.01, default: 0 },
    { key: "y", label: "y", type: "float", min: -10, max: 10, step: 0.01, default: 0 },
    { key: "z", label: "z", type: "float", min: -10, max: 10, step: 0.01, default: 0 },
  ],
  build(ctx) {
    const x = ctx.inputs.x ?? ctx.live("x");
    const y = ctx.inputs.y ?? ctx.live("y");
    const z = ctx.inputs.z ?? ctx.live("z");
    return { vector: vec3(x, y, z) };
  },
};
