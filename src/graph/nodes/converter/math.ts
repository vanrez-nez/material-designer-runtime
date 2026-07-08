import {
  float, mix, max, min, pow, sqrt, abs, sin, cos, tan, asin, acos, atan, sinh, cosh, tanh,
  exp, log, inverseSqrt, radians, degrees, floor, ceil, round, fract, sign, trunc, select,
} from "three/tsl";
import type { MaterialNodeDef, PortDef } from "../../types";

// Math (Blender ShaderNodeMath): one operation over up to three Value inputs. Faithful to Blender's
// full operation set (NOD_math_functions / node_texture_math.cc), including the safe_* guards Blender's
// GPU path applies (divide-by-zero → 0, log/sqrt domain → 0, asin/acos clamp → 0). Unary ops use only A;
// binary use A,B; ternary use A,B,C. `declare()` shows exactly the sockets the op needs (Phase 5), with
// Blender's per-op socket labels. When B / C are unconnected, the `factor` / `c` params stand in for
// them (and `factor` is always the blend amount for `mix`, which is our non-Blender convenience op).
const OPS = [
  // Functions
  "add", "subtract", "multiply", "divide", "multiply-add",
  "power", "logarithm", "sqrt", "inverse-sqrt", "absolute", "exponent",
  // Comparison
  "min", "max", "less-than", "greater-than", "sign", "compare", "smooth-min", "smooth-max",
  // Rounding
  "round", "floor", "ceil", "truncate", "fraction", "modulo", "floored-modulo", "wrap", "snap", "pingpong",
  // Trigonometric
  "sine", "cosine", "tangent", "arcsine", "arccosine", "arctangent", "arctan2", "sinh", "cosh", "tanh",
  // Conversion
  "radians", "degrees",
  // Non-Blender convenience
  "mix",
];

const UNARY = new Set([
  "sqrt", "inverse-sqrt", "absolute", "exponent", "sign", "round", "floor", "ceil", "truncate",
  "fraction", "sine", "cosine", "tangent", "arcsine", "arccosine", "arctangent", "sinh", "cosh",
  "tanh", "radians", "degrees",
]);
const TERNARY = new Set(["multiply-add", "compare", "smooth-min", "smooth-max", "wrap"]);

// Blender's per-op socket labels (only where they deviate from the generic A/B/C).
const LABELS: Record<string, [string, string?, string?]> = {
  power: ["Base", "Exponent"],
  logarithm: ["Value", "Base"],
  "multiply-add": ["Value", "Multiplier", "Addend"],
  compare: ["A", "B", "Epsilon"],
  "smooth-min": ["A", "B", "Distance"],
  "smooth-max": ["A", "B", "Distance"],
  wrap: ["Value", "Max", "Min"],
  snap: ["Value", "Increment"],
  pingpong: ["Value", "Scale"],
  radians: ["Degrees"],
  degrees: ["Radians"],
};

function portsFor(op: string): PortDef[] {
  const [la, lb, lc] = LABELS[op] ?? ["A", "B", "C"];
  const inputs: PortDef[] = [{ key: "a", label: la, kind: "float" }];
  if (!UNARY.has(op)) inputs.push({ key: "b", label: lb ?? "B", kind: "float" });
  if (TERNARY.has(op)) inputs.push({ key: "c", label: lc ?? "C", kind: "float" });
  return inputs;
}

export const mathNode: MaterialNodeDef = {
  type: "math",
  nodeClass: "converter",
  label: "Math",
  inputs: [
    { key: "a", label: "A", kind: "float" },
    { key: "b", label: "B", kind: "float" },
  ],
  outputs: [{ key: "field", kind: "float" }],
  params: [
    { key: "op", label: "op", type: "select", options: OPS, default: "mix" },
    { key: "factor", label: "factor / B", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: "c", label: "C", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 },
  ],
  declare(params) {
    return { inputs: portsFor((params.op as string) ?? "mix"), outputs: [{ key: "field", kind: "float" }] };
  },
  build(ctx) {
    const a = ctx.inputs.a ?? float(0);
    const b = ctx.inputs.b ?? ctx.live("factor");
    const c = ctx.inputs.c ?? ctx.live("c");
    switch (ctx.constant("op") as string) {
      // Functions
      case "add":
        return { field: a.add(b) };
      case "subtract":
        return { field: a.sub(b) };
      case "multiply":
        return { field: a.mul(b) };
      case "divide": // safe: /0 → 0
        return { field: select(b.equal(0), float(0), a.div(b)) };
      case "multiply-add":
        return { field: a.mul(b).add(c) };
      case "power":
        return { field: pow(a, b) };
      case "logarithm": // safe: only defined for a>0, base>0
        return { field: select(a.greaterThan(0).and(b.greaterThan(0)), log(a).div(log(b)), float(0)) };
      case "sqrt":
        return { field: sqrt(a) };
      case "inverse-sqrt": // safe: a>0
        return { field: select(a.greaterThan(0), inverseSqrt(a), float(0)) };
      case "absolute":
        return { field: abs(a) };
      case "exponent":
        return { field: exp(a) };
      // Comparison
      case "min":
        return { field: min(a, b) };
      case "max":
        return { field: max(a, b) };
      case "less-than":
        return { field: select(a.lessThan(b), float(1), float(0)) };
      case "greater-than":
        return { field: select(a.greaterThan(b), float(1), float(0)) };
      case "sign":
        return { field: sign(a) };
      case "compare": // |a-b| <= max(eps, 1e-5)
        return { field: select(a.sub(b).abs().lessThanEqual(max(c, float(1e-5))), float(1), float(0)) };
      case "smooth-min":
        return { field: smoothMin(a, b, c) };
      case "smooth-max": // -smoothmin(-a, -b, c)
        return { field: smoothMin(a.negate(), b.negate(), c).negate() };
      // Rounding
      case "round":
        return { field: round(a) };
      case "floor":
        return { field: floor(a) };
      case "ceil":
        return { field: ceil(a) };
      case "truncate":
        return { field: trunc(a) };
      case "fraction":
        return { field: fract(a) };
      case "modulo": // truncated fmod: a - b*trunc(a/b); safe /0 → 0
        return { field: select(b.equal(0), float(0), a.sub(b.mul(trunc(a.div(b))))) };
      case "floored-modulo": // a - b*floor(a/b); safe /0 → 0
        return { field: select(b.equal(0), float(0), a.sub(b.mul(floor(a.div(b))))) };
      case "wrap": // wrapf(value=a, max=b, min=c)
        return { field: wrap(a, b, c) };
      case "snap": // floor(a/b)*b; safe /0 → 0
        return { field: select(b.equal(0), float(0), floor(a.div(b)).mul(b)) };
      case "pingpong":
        return { field: pingpong(a, b) };
      // Trigonometric
      case "sine":
        return { field: sin(a) };
      case "cosine":
        return { field: cos(a) };
      case "tangent":
        return { field: tan(a) };
      case "arcsine": // safe: |a|<=1
        return { field: select(a.abs().lessThanEqual(1), asin(a), float(0)) };
      case "arccosine": // safe: |a|<=1
        return { field: select(a.abs().lessThanEqual(1), acos(a), float(0)) };
      case "arctangent":
        return { field: atan(a) };
      case "arctan2":
        return { field: atan(a, b) };
      case "sinh":
        return { field: sinh(a) };
      case "cosh":
        return { field: cosh(a) };
      case "tanh":
        return { field: tanh(a) };
      // Conversion
      case "radians":
        return { field: radians(a) };
      case "degrees":
        return { field: degrees(a) };
      // Non-Blender convenience
      case "mix":
      default:
        return { field: mix(a, b, ctx.live("factor")) };
    }
  },
};

// Blender BLI smoothminf(a, b, c): c≠0 ? min(a,b) - h³·c/6 with h=max(c-|a-b|,0)/c : min(a,b).
function smoothMin(a: ReturnType<typeof float>, b: ReturnType<typeof float>, c: ReturnType<typeof float>) {
  const h = max(c.sub(a.sub(b).abs()), float(0)).div(c);
  const smooth = min(a, b).sub(h.mul(h).mul(h).mul(c).div(6));
  return select(c.equal(0), min(a, b), smooth);
}

// Blender BLI wrapf(value, max, min): range=max-min; range≠0 ? value - range·floor((value-min)/range) : min.
function wrap(value: ReturnType<typeof float>, mx: ReturnType<typeof float>, mn: ReturnType<typeof float>) {
  const range = mx.sub(mn);
  return select(range.equal(0), mn, value.sub(range.mul(floor(value.sub(mn).div(range)))));
}

// Blender BLI pingpongf(a, scale): scale≠0 ? |fract((a-scale)/(scale·2))·scale·2 - scale| : 0.
function pingpong(a: ReturnType<typeof float>, scale: ReturnType<typeof float>) {
  const s2 = scale.mul(2);
  return select(scale.equal(0), float(0), fract(a.sub(scale).div(s2)).mul(s2).sub(scale).abs());
}
