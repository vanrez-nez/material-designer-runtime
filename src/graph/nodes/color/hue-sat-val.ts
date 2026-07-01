import { vec3, fract, mix } from "three/tsl";
import type { MaterialNodeDef } from "../../types";
import { rgbToHsv, hsvToRgb } from "../../../tsl/blender-color";

// Hue/Saturation/Value (Blender ShaderNodeHueSaturation). Verbatim hue_sat: convert to HSV, shift hue
// (input centred at 0.5 → no shift), scale saturation (clamped) and value, convert back, mix by Fac.
export const hueSatValNode: MaterialNodeDef = {
  type: "hue-sat-val",
  nodeClass: "color",
  label: "Hue / Saturation",
  inputs: [{ key: "color", label: "Color", kind: "color" }],
  outputs: [{ key: "color", kind: "color" }],
  params: [
    { key: "hue", label: "hue", type: "float", min: 0, max: 1, step: 0.001, default: 0.5 },
    { key: "saturation", label: "saturation", type: "float", min: 0, max: 2, step: 0.01, default: 1 },
    { key: "value", label: "value", type: "float", min: 0, max: 2, step: 0.01, default: 1 },
    { key: "fac", label: "fac", type: "float", min: 0, max: 1, step: 0.01, default: 1 },
  ],
  build(ctx) {
    const col = ctx.inputs.color ?? vec3(0.8, 0.8, 0.8);
    const hsv = rgbToHsv(col);
    const h = fract(hsv.x.add(ctx.uniforms.hue).add(0.5));
    const s = hsv.y.mul(ctx.uniforms.saturation).clamp(0, 1);
    const v = hsv.z.mul(ctx.uniforms.value);
    return { color: mix(col, hsvToRgb(vec3(h, s, v)), ctx.uniforms.fac) };
  },
};
