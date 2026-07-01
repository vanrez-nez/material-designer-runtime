import { float, clamp, min, max } from "three/tsl";
import type { MaterialNodeDef } from "../../types";

// Clamp (Blender ShaderNodeClamp). Min Max: clamp(value, min, max). Range: if min > max, clamp to
// [max, min] (auto-swap) — matches Blender's clamp_range.
export const clampNode: MaterialNodeDef = {
  type: "clamp",
  nodeClass: "converter",
  label: "Clamp",
  inputs: [
    { key: "value", label: "Value", kind: "float" },
    { key: "min", label: "Min", kind: "float" },
    { key: "max", label: "Max", kind: "float" },
  ],
  outputs: [{ key: "field", kind: "float" }],
  params: [
    { key: "mode", label: "mode", type: "select", options: ["minmax", "range"], default: "minmax" },
    { key: "min", label: "min", type: "float", min: -10, max: 10, step: 0.01, default: 0 },
    { key: "max", label: "max", type: "float", min: -10, max: 10, step: 0.01, default: 1 },
  ],
  build(ctx) {
    const v = ctx.inputs.value ?? float(0);
    const lo = ctx.inputs.min ?? ctx.uniforms.min;
    const hi = ctx.inputs.max ?? ctx.uniforms.max;
    if ((ctx.params.mode as string) === "range") {
      // clamp to [min(lo,hi), max(lo,hi)] — handles a reversed range.
      return { field: v.clamp(min(lo, hi), max(lo, hi)) };
    }
    return { field: clamp(v, lo, hi) };
  },
};
