import type { MaterialNodeDef, MaterialValue } from "../../types";
import { shapeField } from "../../../tsl/shape";

type V = MaterialValue;

const SHAPES = ["blob", "polygon"];

// Shape — draws one silhouette (mask + domed height) in a LOCAL coordinate frame (unit disc ≈ footprint).
// The swappable counterpart to Scatter: wire `Scatter.coord` → `coord` and `Scatter.value` → `seed` so every
// scattered instance gets a different shape. `blob` is round/lumpy (irregularity), `polygon` is an angular
// n-gon (sides). Works standalone too (e.g. a Tex Coordinate centred at 0.5 → a single shape).
export const shapeNode: MaterialNodeDef = {
  type: "shape",
  nodeClass: "texture",
  label: "Shape",
  inputs: [
    { key: "coord", kind: "vector" },
    { key: "seed", label: "Seed", kind: "float" },
  ],
  outputs: [
    { key: "mask", label: "Mask", kind: "float" },
    { key: "height", label: "Height", kind: "float" },
  ],
  params: [
    { key: "shape", label: "shape", type: "select", options: SHAPES, default: "blob" },
    { key: "sides", label: "sides", type: "int", min: 3, max: 12, step: 1, default: 6 },
    { key: "irregularity", label: "irregularity", type: "float", min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: "dome", label: "dome", type: "float", min: 0.2, max: 3, step: 0.05, default: 0.6 },
    { key: "edge", label: "edge soft", type: "float", min: 0.002, max: 0.3, step: 0.002, default: 0.04 },
    { key: "tilt", label: "tilt", type: "float", min: 0, max: 1, step: 0.01, default: 0 },
    { key: "formRandom", label: "form rand", type: "float", min: 0, max: 1, step: 0.01, default: 0 },
    { key: "erode", label: "erode", type: "float", min: 0, max: 1, step: 0.01, default: 0 },
    // Structural opt-in: each tap re-evaluates the whole silhouette, multiplying shader size and pipeline
    // compile time — so tap count is an explicit select, while `erode` strength stays a draggable uniform.
    { key: "erodeTaps", label: "erode taps", type: "select", options: ["off", "4"], default: "off" },
  ],
  build(ctx) {
    const coord = (ctx.inputs.coord ?? ctx.coord) as V;
    const seed = ctx.inputs.seed as V | undefined;
    const shape = (ctx.constant("shape") as string) ?? "blob";
    const rawSides = Math.round(Number(ctx.constant("sides") ?? 6));
    const sides = Number.isFinite(rawSides) ? Math.max(3, rawSides) : 6;
    // Tolerant parse: the UI stores the select as the string "4", but MCP/scripted edits may send a number.
    const erodeTaps = parseInt(String(ctx.constant("erodeTaps") ?? "off"), 10) || 0;
    const { mask, height } = shapeField(coord, shape, sides, erodeTaps, seed ?? null, {
      irregularity: ctx.live("irregularity") as V,
      dome: ctx.live("dome") as V,
      edge: ctx.live("edge") as V,
      tilt: ctx.live("tilt") as V,
      formRandom: ctx.live("formRandom") as V,
      erode: ctx.live("erode") as V,
    });
    return { mask, height };
  },
};
