import { color, mix, float } from "three/tsl";
import type { MaterialNodeDef } from "../../types";

// Layer two colours with a blend mode, gated by an optional mask × opacity. The generic mechanism the
// old gradient-map.ts hardcoded per-feature (moss / exposed-wood overlays become separate Blend layers).
export const blendNode: MaterialNodeDef = {
  type: "blend",
  nodeClass: "color",
  label: "Blend",
  inputs: [
    { key: "a", label: "base", kind: "color" },
    { key: "b", label: "over", kind: "color" },
    { key: "mask", kind: "float" },
  ],
  outputs: [{ key: "color", kind: "color" }],
  params: [
    {
      key: "mode",
      label: "mode",
      type: "select",
      options: ["mix", "multiply", "screen", "add"],
      default: "mix",
    },
    { key: "opacity", label: "opacity", type: "float", min: 0, max: 1, step: 0.01, default: 1 },
  ],
  build(ctx) {
    const a = ctx.inputs.a ?? color(0x000000);
    const b = ctx.inputs.b ?? color(0xffffff);
    let blended;
    switch (ctx.constant("mode") as string) {
      case "multiply":
        blended = a.mul(b);
        break;
      case "screen":
        blended = a.oneMinus().mul(b.oneMinus()).oneMinus();
        break;
      case "add":
        blended = a.add(b);
        break;
      case "mix":
      default:
        blended = b;
        break;
    }
    const m = (ctx.inputs.mask ?? float(1)).mul(ctx.live("opacity"));
    return { color: mix(a, blended, m) };
  },
};
