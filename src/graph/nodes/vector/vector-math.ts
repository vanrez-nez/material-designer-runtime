import { vec3, cross, reflect, dot, floor, ceil, fract, min, max, sin, cos, tan } from "three/tsl";
import type { MaterialNodeDef, PortDef } from "../../types";

// Vector Math (Blender ShaderNodeVectorMath). Operation is a build-time select; A/B are vector inputs,
// `scale` a float param (for the Scale op). Outputs follow the operation via declare(): the reduction
// ops (Dot/Distance/Length) expose a single `value` (float); all others expose `vector`.
const OPS = [
  "add", "subtract", "multiply", "divide", "cross", "project", "reflect", "dot", "distance", "length",
  "scale", "normalize", "snap", "floor", "ceil", "fraction", "absolute", "minimum", "maximum",
  "sine", "cosine", "tangent",
];
const VALUE_OPS = new Set(["dot", "distance", "length"]);
const VEC_INPUTS: PortDef[] = [
  { key: "vector1", label: "A", kind: "vector" },
  { key: "vector2", label: "B", kind: "vector" },
];

export const vectorMathNode: MaterialNodeDef = {
  type: "vector-math",
  nodeClass: "vector",
  label: "Vector Math",
  inputs: VEC_INPUTS,
  outputs: [{ key: "vector", label: "Vector", kind: "vector" }],
  params: [
    { key: "operation", label: "op", type: "select", options: OPS, default: "add" },
    { key: "scale", label: "scale", type: "float", min: -8, max: 8, step: 0.01, default: 1 },
  ],
  declare(params) {
    const op = (params.operation as string) ?? "add";
    return {
      inputs: VEC_INPUTS,
      outputs: VALUE_OPS.has(op)
        ? [{ key: "value", label: "Value", kind: "float" }]
        : [{ key: "vector", label: "Vector", kind: "vector" }],
    };
  },
  build(ctx) {
    const a = ctx.inputs.vector1 ?? ctx.coord;
    const b = ctx.inputs.vector2 ?? vec3(0, 0, 0);
    switch ((ctx.constant("operation") as string) ?? "add") {
      case "subtract":
        return { vector: a.sub(b) };
      case "multiply":
        return { vector: a.mul(b) };
      case "divide":
        return { vector: a.div(b) };
      case "cross":
        return { vector: cross(a, b) };
      case "project":
        return { vector: b.mul(dot(a, b).div(dot(b, b))) };
      case "reflect":
        return { vector: reflect(a, b.normalize()) };
      case "dot":
        return { value: dot(a, b) };
      case "distance":
        return { value: a.sub(b).length() };
      case "length":
        return { value: a.length() };
      case "scale":
        return { vector: a.mul(ctx.live("scale")) };
      case "normalize":
        return { vector: a.normalize() };
      case "snap":
        return { vector: floor(a.div(b)).mul(b) };
      case "floor":
        return { vector: floor(a) };
      case "ceil":
        return { vector: ceil(a) };
      case "fraction":
        return { vector: fract(a) };
      case "absolute":
        return { vector: a.abs() };
      case "minimum":
        return { vector: min(a, b) };
      case "maximum":
        return { vector: max(a, b) };
      case "sine":
        return { vector: sin(a) };
      case "cosine":
        return { vector: cos(a) };
      case "tangent":
        return { vector: tan(a) };
      default:
        return { vector: a.add(b) };
    }
  },
};
