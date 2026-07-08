import type { MaterialBundle, MaterialNodeDef, MaterialValue, ParamDef } from "../../types";

// Param definitions, hoisted so build()'s `num()` can fall back to each param's *declared* default when a
// param is absent from the document (e.g. a Principled with `params: {}`). Falling back to 0 instead
// would wrongly trip `alpha < 1` and force the whole material onto the (much costlier) transparent path.
const PARAMS: ParamDef[] = [
  { key: "baseColor", label: "base color", type: "color", default: "#cccccc" },
  { key: "metallic", label: "metallic", type: "float", min: 0, max: 1, step: 0.01, default: 0 },
  { key: "roughness", label: "roughness", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 },
  { key: "ior", label: "IOR", type: "float", min: 1, max: 2.5, step: 0.01, default: 1.5 },
  { key: "alpha", label: "alpha", type: "float", min: 0, max: 1, step: 0.01, default: 1, bakeStructural: true },
  { key: "coat", label: "coat weight", type: "float", min: 0, max: 1, step: 0.01, default: 0 },
  { key: "coatRoughness", label: "coat rough", type: "float", min: 0, max: 1, step: 0.01, default: 0.03 },
  { key: "sheen", label: "sheen weight", type: "float", min: 0, max: 1, step: 0.01, default: 0 },
  { key: "sheenRoughness", label: "sheen rough", type: "float", min: 0, max: 1, step: 0.01, default: 0.3 },
  { key: "transmission", label: "transmission", type: "float", min: 0, max: 1, step: 0.01, default: 0 },
  { key: "emission", label: "emission", type: "color", default: "#000000", bakeStructural: true },
  { key: "emissionStrength", label: "emission str", type: "float", min: 0, max: 10, step: 0.1, default: 1 },
];
const NUM_DEFAULTS: Record<string, number> = Object.fromEntries(
  PARAMS.filter((p) => p.type === "float" || p.type === "int").map((p) => [p.key, p.default as number]),
);

// Principled BSDF — the single grounded BSDF (plan L1/L2). Its typed inputs mirror Blender's Principled
// and map onto MeshPhysicalNodeMaterial channels; its `bsdf` output is the constrained green Shader
// marker that only Material Output consumes. No real closure flows — build() returns a MaterialBundle
// the compiler unpacks. Unconnected inputs fall back to the node's params (like Blender's sliders).
//
// Physical lobes (coat / sheen / transmission) are only included when connected OR their weight param is
// > 0, so an otherwise-plain material doesn't enable those (slightly different, costlier) shader
// branches — matching `useClearcoat/useSheen/useTransmission` in MeshPhysicalNodeMaterial.
//
// Partial vs Blender (plan L2): Subsurface, Anisotropy, Specular Tint, and Tangent are NOT yet exposed
// (three.js support differs); Alpha maps to opacity but does not toggle transparency here.
export const principledBsdfNode: MaterialNodeDef = {
  type: "principled-bsdf",
  nodeClass: "shader",
  label: "Principled BSDF",
  inputs: [
    { key: "baseColor", label: "Base Color", kind: "color" },
    { key: "metallic", label: "Metallic", kind: "float" },
    { key: "roughness", label: "Roughness", kind: "float" },
    { key: "ior", label: "IOR", kind: "float" },
    { key: "alpha", label: "Alpha", kind: "float" },
    { key: "normal", label: "Normal", kind: "vector" },
    { key: "height", label: "Height", kind: "float" },
    { key: "ambientOcclusion", label: "Ambient Occlusion", kind: "float" },
    { key: "coat", label: "Coat Weight", kind: "float" },
    { key: "coatRoughness", label: "Coat Roughness", kind: "float" },
    { key: "sheen", label: "Sheen Weight", kind: "float" },
    { key: "sheenRoughness", label: "Sheen Roughness", kind: "float" },
    { key: "transmission", label: "Transmission", kind: "float" },
    { key: "emission", label: "Emission Color", kind: "color" },
    { key: "emissionStrength", label: "Emission Strength", kind: "float" },
  ],
  outputs: [{ key: "bsdf", kind: "shader" }],
  params: PARAMS,
  build(ctx): Record<string, MaterialValue> {
    // Connected input, else the param uniform (Blender's slider fallback).
    const inOr = (k: string): MaterialValue => ctx.inputs[k] ?? ctx.live(k);
    // Numeric param value, falling back to the param's declared default (not 0) when absent.
    const num = (k: string): number => Number((ctx.constant(k) as number) ?? NUM_DEFAULTS[k] ?? 0);
    // A physical lobe: connected input, else the param uniform only when the weight is non-zero.
    const lobe = (k: string): MaterialValue | undefined =>
      ctx.inputs[k] !== undefined ? ctx.inputs[k] : num(k) > 0 ? ctx.live(k) : undefined;

    const emitConnected = ctx.inputs.emission !== undefined || ctx.inputs.emissionStrength !== undefined;
    // ctx.constant holds only doc-provided values; fall back to the black default when omitted.
    const emitActive = emitConnected || ((ctx.constant("emission") as string) ?? "#000000") !== "#000000";
    const emission = emitActive
      ? (ctx.inputs.emission ?? ctx.live("emission")).mul(ctx.inputs.emissionStrength ?? ctx.live("emissionStrength"))
      : undefined;

    const coat = lobe("coat");
    const sheen = lobe("sheen");
    const bundle: MaterialBundle = {
      baseColor: inOr("baseColor"),
      metallic: inOr("metallic"),
      roughness: inOr("roughness"),
      ior: inOr("ior"),
      normal: ctx.inputs.normal, // undefined → interpolated geometry normal
      // Scalar height for offline parallax-occlusion mapping. Input-only (no slider): undefined when
      // unconnected so no height map is baked and the surface samples flat. Drive it from the same field
      // that feeds Normal From Height for relief that matches the normal map.
      height: ctx.inputs.height,
      // Texture-scale AO authored in the graph (mortar lines, pores, grooves). Input-only — undefined when
      // unconnected so no AO channel is baked; composes with the mesh's per-vertex form AO downstream.
      ambientOcclusion: ctx.inputs.ambientOcclusion,
      alpha: ctx.inputs.alpha !== undefined ? ctx.inputs.alpha : num("alpha") < 1 ? ctx.live("alpha") : undefined,
      emission,
      coat,
      coatRoughness: coat !== undefined ? inOr("coatRoughness") : undefined,
      sheen,
      sheenRoughness: sheen !== undefined ? inOr("sheenRoughness") : undefined,
      transmission: lobe("transmission"),
    };
    return { bsdf: bundle };
  },
};
