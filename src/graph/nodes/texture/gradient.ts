import type { MaterialNodeDef } from "../../types";
import { blenderGradient } from "../../../tsl/blender-gradient";

const TYPES = ["linear", "quadratic", "easing", "diagonal", "radial", "quadratic-sphere", "sphere"];

// Gradient Texture (Blender ShaderNodeTexGradient, Fac output) — faithful port (tsl/blender-gradient.ts).
// `scale` multiplies the domain; `type` is a build-time select.
export const gradientNode: MaterialNodeDef = {
  type: "gradient",
  nodeClass: "texture",
  label: "Gradient",
  inputs: [{ key: "coord", kind: "vector" }],
  outputs: [{ key: "field", kind: "float" }],
  params: [
    { key: "scale", label: "scale", type: "float", min: 0.1, max: 8, step: 0.05, default: 1 },
    { key: "gradientType", label: "type", type: "select", options: TYPES, default: "linear" },
  ],
  build(ctx) {
    const p = (ctx.inputs.coord ?? ctx.coord).mul(ctx.live("scale"));
    const type = Math.max(0, TYPES.indexOf(ctx.constant("gradientType") as string));
    return { field: blenderGradient(p, type) };
  },
};
