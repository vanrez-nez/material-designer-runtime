import { mix, clamp, float } from "three/tsl";
import type { MaterialNodeDef } from "../../types";

// Pure field -> colour lookup (two-stop for v1; Phase 3 widens to a multi-stop ramp). Decouples
// colour authoring from the height pipeline — the bark look becomes preset stop values, not a
// hardcoded shader (the old gradient-map.ts conflated the two).
export const colorRampNode: MaterialNodeDef = {
  type: "color-ramp",
  nodeClass: "converter",
  label: "Color Ramp",
  inputs: [{ key: "field", kind: "float" }],
  outputs: [{ key: "color", kind: "color" }],
  params: [
    { key: "colorA", label: "low", type: "color", default: "#3f2d1e" },
    { key: "colorB", label: "high", type: "color", default: "#8a6a4a" },
    { key: "low", label: "low stop", type: "float", min: 0, max: 1, step: 0.01, default: 0.3 },
    { key: "high", label: "high stop", type: "float", min: 0, max: 1, step: 0.01, default: 0.75 },
  ],
  build(ctx) {
    const f = ctx.inputs.field ?? float(0.5);
    // Linear interpolation between the two stops (Blender ColorRamp's default), clamped outside [low,high].
    // (Was smoothstep, which softened the ramp differently from Blender.)
    const lo = ctx.live("low");
    const hi = ctx.live("high");
    const t = clamp(f.sub(lo).div(hi.sub(lo).max(1e-5)), 0, 1);
    return { color: mix(ctx.live("colorA"), ctx.live("colorB"), t) };
  },
};
