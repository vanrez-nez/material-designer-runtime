import { mix, float } from "three/tsl";
import type { MaterialNodeDef } from "../../types";

// Generic scalar remap: maps an input field into [outMin, outMax], optionally inverted. Used to drive
// roughness/metallic/AO from a shared field (replaces the bespoke roughness.ts math).
export const levelsNode: MaterialNodeDef = {
  type: "levels",
  nodeClass: "converter",
  label: "Levels / Remap",
  inputs: [{ key: "field", kind: "float" }],
  outputs: [{ key: "field", kind: "float" }],
  params: [
    { key: "min", label: "out min", type: "float", min: 0, max: 1, step: 0.01, default: 0 },
    { key: "max", label: "out max", type: "float", min: 0, max: 1, step: 0.01, default: 1 },
    { key: "invert", label: "invert", type: "bool", default: false },
  ],
  build(ctx) {
    const input = ctx.inputs.field ?? float(0.5);
    const f = ctx.constant("invert") ? input.oneMinus() : input;
    return { field: mix(ctx.live("min"), ctx.live("max"), f) };
  },
};
