import { vec3, float } from "three/tsl";
import type { MaterialNodeDef } from "../../types";

// Bright/Contrast (Blender ShaderNodeBrightContrast). Verbatim: a = 1 + contrast; b = bright - contrast/2;
// out = max(a*col + b, 0).
export const brightContrastNode: MaterialNodeDef = {
  type: "bright-contrast",
  nodeClass: "color",
  label: "Bright / Contrast",
  inputs: [
    { key: "color", label: "Color", kind: "color" },
    { key: "bright", label: "Bright", kind: "float" },
    { key: "contrast", label: "Contrast", kind: "float" },
  ],
  outputs: [{ key: "color", kind: "color" }],
  params: [
    { key: "bright", label: "bright", type: "float", min: -1, max: 1, step: 0.01, default: 0 },
    { key: "contrast", label: "contrast", type: "float", min: -1, max: 1, step: 0.01, default: 0 },
  ],
  build(ctx) {
    const col = ctx.inputs.color ?? vec3(0, 0, 0);
    const contrast = ctx.inputs.contrast ?? ctx.live("contrast");
    const bright = ctx.inputs.bright ?? ctx.live("bright");
    const a = float(1).add(contrast);
    const b = bright.sub(contrast.mul(0.5));
    return { color: col.mul(a).add(b).max(0) };
  },
};
