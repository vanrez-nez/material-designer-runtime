import { floor, mod, select, float } from "three/tsl";
import type { MaterialNodeDef, MaterialValue } from "../../types";

type V = MaterialValue;

// Checker Texture (Blender ShaderNodeTexChecker). A 2-colour checkerboard: the parity of the summed,
// scaled lattice cells picks color1 vs color2. `scale` multiplies the domain (cells per unit). Outputs the
// Color and a Fac (1 in color1 cells, 0 in color2). Inputs override the colour params (like Blender's
// sockets). In the offline (uv) bake the z term is 0 → a clean 2D checker.
export const checkerNode: MaterialNodeDef = {
  type: "checker",
  nodeClass: "texture",
  label: "Checker",
  inputs: [
    { key: "coord", kind: "vector" },
    { key: "color1", label: "Color1", kind: "color" },
    { key: "color2", label: "Color2", kind: "color" },
  ],
  outputs: [
    { key: "color", kind: "color" },
    { key: "fac", label: "Fac", kind: "float" },
  ],
  params: [
    { key: "color1", label: "color1", type: "color", default: "#c4201e" },
    { key: "color2", label: "color2", type: "color", default: "#18b6b6" },
    { key: "scale", label: "scale", type: "float", min: 0.5, max: 32, step: 0.5, default: 4 },
  ],
  build(ctx) {
    const p = (ctx.inputs.coord ?? ctx.coord).mul(ctx.uniforms.scale) as V;
    const parity = mod(floor(p.x).add(floor(p.y)).add(floor(p.z)), 2) as V; // 0 → color1, 1 → color2
    const isC1 = parity.lessThan(1) as V;
    const c1 = (ctx.inputs.color1 ?? ctx.uniforms.color1) as V;
    const c2 = (ctx.inputs.color2 ?? ctx.uniforms.color2) as V;
    return { color: select(isC1, c1, c2), fac: select(isC1, float(1), float(0)) };
  },
};
