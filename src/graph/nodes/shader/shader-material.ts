import {
  MATERIAL_TYPES,
  MATERIAL_TYPE_CAPS,
  SHADER_MATERIAL_TYPE,
  normalizeMaterialType,
  type MaterialBundle,
  type MaterialNodeDef,
  type MaterialValue,
  type ParamDef,
  type PortDef,
} from "../../types";

// Full superset of PBR channel inputs (same kinds/labels as the legacy Principled BSDF). `declare()` picks
// the per-type subset; unconnected inputs fall back to the matching param uniform (Blender's slider model).
const IN: Record<string, PortDef> = {
  baseColor: { key: "baseColor", label: "Base Color", kind: "color" },
  metallic: { key: "metallic", label: "Metallic", kind: "float" },
  roughness: { key: "roughness", label: "Roughness", kind: "float" },
  ior: { key: "ior", label: "IOR", kind: "float" },
  alpha: { key: "alpha", label: "Alpha", kind: "float" },
  normal: { key: "normal", label: "Normal", kind: "vector" },
  height: { key: "height", label: "Height", kind: "float" },
  ambientOcclusion: { key: "ambientOcclusion", label: "Ambient Occlusion", kind: "float" },
  coat: { key: "coat", label: "Coat Weight", kind: "float" },
  coatRoughness: { key: "coatRoughness", label: "Coat Roughness", kind: "float" },
  sheen: { key: "sheen", label: "Sheen Weight", kind: "float" },
  sheenRoughness: { key: "sheenRoughness", label: "Sheen Roughness", kind: "float" },
  transmission: { key: "transmission", label: "Transmission", kind: "float" },
  emission: { key: "emission", label: "Emission Color", kind: "color" },
  emissionStrength: { key: "emissionStrength", label: "Emission Strength", kind: "float" },
};

// Inputs shared by every lit family. Matcap (unlit) drops ao/emission; Standard/Physical add the metal-
// workflow (and Physical the extra lobes) — see declare().
const COMMON_IN: PortDef[] = [
  IN.baseColor,
  IN.alpha,
  IN.normal,
  IN.height,
  IN.ambientOcclusion,
  IN.emission,
  IN.emissionStrength,
];
const MATCAP_IN: PortDef[] = [IN.baseColor, IN.alpha, IN.normal, IN.height];
const METAL_IN: PortDef[] = [IN.metallic, IN.roughness];
const PHYSICAL_IN: PortDef[] = [
  IN.ior,
  IN.coat,
  IN.coatRoughness,
  IN.sheen,
  IN.sheenRoughness,
  IN.transmission,
];
const BSDF_OUT: PortDef[] = [{ key: "bsdf", kind: "shader" }];

const PARAMS: ParamDef[] = [
  // The material family. `select` on a declare-node ⇒ structural: switching reshapes sockets/controls and
  // reconstructs the THREE material (the controller prunes edges to sockets the new type drops).
  { key: "materialType", label: "type", type: "select", options: MATERIAL_TYPES, default: "physical" },
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
  // Phong-only, applied at construction (newSurfaceMaterial) → structural so both backends reconstruct.
  { key: "shininess", label: "shininess", type: "float", min: 1, max: 200, step: 1, default: 30, structural: true },
  { key: "specular", label: "specular", type: "color", default: "#111111", structural: true },
  // Toon cel bands → a synthesized gradient map (int ⇒ structural).
  { key: "gradientSteps", label: "gradient steps", type: "int", min: 2, max: 5, step: 1, default: 3 },
  // Matcap look id (select ⇒ structural); "default" uses the material's built-in gradient (no asset yet).
  { key: "matcap", label: "matcap", type: "select", options: ["default"], default: "default" },
];
const NUM_DEFAULTS: Record<string, number> = Object.fromEntries(
  PARAMS.filter((p) => p.type === "float" || p.type === "int").map((p) => [p.key, p.default as number]),
);

// Which inline controls take effect for the current family (editor-only filter — the compiler still builds
// uniforms for every param). Mirrors declare()'s socket set: metal workflow for Standard/Physical, the extra
// lobes for Physical, shininess/specular for Phong, gradient steps for Toon, matcap look for Matcap (unlit,
// so its emission controls are hidden).
function paramsFor(params: Record<string, unknown>): ParamDef[] {
  const t = normalizeMaterialType(params.materialType);
  const show = new Set(["materialType", "baseColor", "alpha", "emission", "emissionStrength"]);
  if (t === "standard" || t === "physical") {
    show.add("metallic");
    show.add("roughness");
  }
  if (t === "physical")
    for (const k of ["ior", "coat", "coatRoughness", "sheen", "sheenRoughness", "transmission"]) show.add(k);
  if (t === "phong") {
    show.add("shininess");
    show.add("specular");
  }
  if (t === "toon") show.add("gradientSteps");
  if (t === "matcap") {
    show.delete("emission");
    show.delete("emissionStrength");
    show.add("matcap");
  }
  return PARAMS.filter((p) => show.has(p.key));
}

// The polymorphic surface node (replaces Principled BSDF). A `materialType` select chooses one of the six
// stock THREE material families; declare()/paramsFor() reshape the sockets/controls to that family, and
// build() emits ONLY the MaterialBundle channels the family lights (per MATERIAL_TYPE_CAPS) — so the offline
// baker automatically bakes fewer channels for the non-PBR families. Type/settings are transported in the
// document (this node's params) and reconstructed on load by the compiler's readMaterialSurface. Unconnected
// inputs fall back to their param uniforms, exactly like Principled BSDF.
export const shaderMaterialNode: MaterialNodeDef = {
  type: SHADER_MATERIAL_TYPE,
  nodeClass: "shader",
  label: "Material",
  // Static fallback interface (palette / no-declare consumers) = the Physical superset.
  inputs: [...COMMON_IN, ...METAL_IN, ...PHYSICAL_IN],
  outputs: BSDF_OUT,
  params: PARAMS,
  declare(params) {
    const t = normalizeMaterialType(params.materialType);
    switch (t) {
      case "standard":
        return { inputs: [...COMMON_IN, ...METAL_IN], outputs: BSDF_OUT };
      case "physical":
        return { inputs: [...COMMON_IN, ...METAL_IN, ...PHYSICAL_IN], outputs: BSDF_OUT };
      case "matcap":
        return { inputs: MATCAP_IN, outputs: BSDF_OUT };
      // lambert / phong / toon: diffuse-lit, no metal workflow.
      default:
        return { inputs: COMMON_IN, outputs: BSDF_OUT };
    }
  },
  paramsFor,
  build(ctx): Record<string, MaterialValue> {
    const t = normalizeMaterialType(ctx.params.materialType);
    const caps = MATERIAL_TYPE_CAPS[t];
    const u = ctx.uniforms;
    // Connected input, else the param uniform (Blender's slider fallback).
    const inOr = (k: string): MaterialValue => ctx.inputs[k] ?? u[k];
    const num = (k: string): number => Number((ctx.params[k] as number) ?? NUM_DEFAULTS[k] ?? 0);
    // A physical lobe: connected input, else the param uniform only when the weight is non-zero.
    const lobe = (k: string): MaterialValue | undefined =>
      ctx.inputs[k] !== undefined ? ctx.inputs[k] : num(k) > 0 ? u[k] : undefined;

    const emitConnected = ctx.inputs.emission !== undefined || ctx.inputs.emissionStrength !== undefined;
    const emitActive = emitConnected || ((ctx.params.emission as string) ?? "#000000") !== "#000000";
    const emission =
      caps.emissive && emitActive
        ? (ctx.inputs.emission ?? u.emission).mul(ctx.inputs.emissionStrength ?? u.emissionStrength)
        : undefined;

    const bundle: MaterialBundle = {
      baseColor: inOr("baseColor"),
      normal: ctx.inputs.normal, // undefined → interpolated geometry normal
      height: ctx.inputs.height, // input-only, offline parallax
      alpha: ctx.inputs.alpha !== undefined ? ctx.inputs.alpha : num("alpha") < 1 ? u.alpha : undefined,
      emission,
    };
    if (caps.ao) bundle.ambientOcclusion = ctx.inputs.ambientOcclusion; // input-only detail AO
    if (caps.roughMetal) {
      bundle.roughness = inOr("roughness");
      bundle.metallic = inOr("metallic");
    }
    if (caps.physicalLobes) {
      const coat = lobe("coat");
      const sheen = lobe("sheen");
      bundle.ior = inOr("ior");
      bundle.coat = coat;
      bundle.coatRoughness = coat !== undefined ? inOr("coatRoughness") : undefined;
      bundle.sheen = sheen;
      bundle.sheenRoughness = sheen !== undefined ? inOr("sheenRoughness") : undefined;
      bundle.transmission = lobe("transmission");
    }
    return { bsdf: bundle };
  },
};
