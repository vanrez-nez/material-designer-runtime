import { vec3, mix } from "three/tsl";
import type { MaterialNodeDef, MaterialValue } from "../../types";
import { CURVE_IDENTITY } from "../../types";
import { curve5 } from "../../../tsl/curve";

// RGB Curves (Blender ShaderNodeCurveRGB). Four editable tone curves — Combined (C), Red, Green, Blue —
// each a 5-point Catmull-Rom curve (`curve5`) at fixed x = 0/.25/.5/.75/1. Blender's order: the Combined
// curve is applied to every channel first, then the per-channel R/G/B curves; `Fac` blends original vs
// corrected. Edited via the canvas curve widget (the `curves` param of type "curve"); the 20 control-point
// y-values are a live `uniformArray` so dragging updates the render without recompiling.
//
// Grounded deviation from Blender's full CurveMapping: fixed-x control points (drag Y only) with a
// Catmull-Rom interpolation, vs Blender's movable 2D handles, variable point count, and 256-sample baked
// LUT. Black/White Level range-remap inputs are also omitted. See plan §11.
const id = () => [...CURVE_IDENTITY];

export const rgbCurvesNode: MaterialNodeDef = {
  type: "rgb-curves",
  nodeClass: "color",
  label: "RGB Curves",
  inputs: [
    { key: "fac", label: "Fac", kind: "float" },
    { key: "color", label: "Color", kind: "color" },
  ],
  outputs: [{ key: "color", kind: "color" }],
  params: [
    { key: "fac", label: "fac", type: "float", min: 0, max: 1, step: 0.01, default: 1 },
    { key: "curves", label: "curves", type: "curve", default: { C: id(), R: id(), G: id(), B: id() } },
  ],
  build(ctx) {
    const col = ctx.inputs.color ?? vec3(0, 0, 0);
    const arr = ctx.live("curves");
    // 5 control points per channel: C @0, R @5, G @10, B @15.
    const ch = (off: number): MaterialValue[] => [0, 1, 2, 3, 4].map((i) => arr.element(off + i));
    const [C, R, G, B] = [ch(0), ch(5), ch(10), ch(15)];
    // Combined curve first (all channels), then the per-channel curves.
    const r = curve5(curve5(col.x, C), R);
    const g = curve5(curve5(col.y, C), G);
    const b = curve5(curve5(col.z, C), B);
    const fac = ctx.inputs.fac ?? ctx.live("fac");
    return { color: mix(col, vec3(r, g, b), fac) };
  },
};
