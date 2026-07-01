import { mix, vec3, float } from "three/tsl";
import type { MaterialBundle, MaterialNodeDef, MaterialValue } from "../../types";

// Mix Shader (Blender's Mix Shader) — the GENERAL material-layering primitive. It blends two whole material
// bundles channel-by-channel by a single `fac` ∈ [0,1] (0 = A, 1 = B). This decouples "how you blend"
// (a linear per-channel mix, here) from "what the mask is" (`fac` is any float field: a gradient, a noise, a
// slope, a painted map, a Height Blend for feature-aware transitions, …). Layer materials with it:
//   Principled(tiles) ─┐
//   Principled(gravel) ─┼─ Mix Shader ─→ Material Output
//   mask field ─────────┘
// Stack several for >2 materials. lava+rock is the same node: rock Principled + lava Emission, fac = a crack
// mask — height isn't required, it's just one possible mask source.
type V = MaterialValue;

// Channel → its renderer default, used when only ONE side defines a channel (the other fades to/from the
// default). Channels absent on both sides stay absent (renderer default). Normal has no scalar default — if
// one side lacks it we keep the present one (mixing against an implicit geometry normal isn't meaningful).
const DEFAULTS: Partial<Record<keyof MaterialBundle, V>> = {
  emission: vec3(0, 0, 0),
  ambientOcclusion: float(1),
  alpha: float(1),
  coat: float(0),
  sheen: float(0),
  transmission: float(0),
};

const CHANNELS: (keyof MaterialBundle)[] = [
  "baseColor", "metallic", "roughness", "ior", "alpha", "ambientOcclusion",
  "emission", "normal", "coat", "coatRoughness", "sheen", "sheenRoughness", "transmission",
];

function mixBundle(a: MaterialBundle, b: MaterialBundle, f: V): MaterialBundle {
  const out: MaterialBundle = {};
  for (const k of CHANNELS) {
    const av = a[k] as V | undefined;
    const bv = b[k] as V | undefined;
    if (av === undefined && bv === undefined) continue;
    if (av !== undefined && bv !== undefined) {
      // Plain per-channel lerp — including `normal`. The offline normal is an ENCODED [0,1] tangent normal,
      // so it must NOT be renormalized here (that shifts a flat 0.5 toward 0.41 and corrupts the map); the
      // surface shader normalizes the decoded normal anyway. Keep the transition band narrow (Height Blend)
      // to minimise the slight denormalization mid-blend.
      out[k] = mix(av, bv, f) as V;
      continue;
    }
    const def = DEFAULTS[k];
    if (def === undefined) {
      out[k] = (av ?? bv) as V; // e.g. normal — keep the present side
    } else {
      // fade the present side against its default so a one-sided channel (emission, a lobe…) blends in/out.
      out[k] = (av !== undefined ? mix(av, def, f) : mix(def, bv as V, f)) as V;
    }
  }
  return out;
}

export const mixShaderNode: MaterialNodeDef = {
  type: "mix-shader",
  nodeClass: "shader",
  label: "Mix Shader",
  inputs: [
    { key: "shaderA", label: "Shader A", kind: "shader" },
    { key: "shaderB", label: "Shader B", kind: "shader" },
    { key: "fac", label: "Fac", kind: "float" },
  ],
  outputs: [{ key: "shader", kind: "shader" }],
  params: [{ key: "fac", label: "fac", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 }],
  build(ctx): Record<string, MaterialValue> {
    const a = (ctx.inputs.shaderA ?? {}) as MaterialBundle;
    const b = (ctx.inputs.shaderB ?? {}) as MaterialBundle;
    const f = (ctx.inputs.fac ?? ctx.uniforms.fac) as V;
    return { shader: mixBundle(a, b, f) };
  },
};
