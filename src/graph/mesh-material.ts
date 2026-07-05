import * as THREE from "three";
import { MATERIAL_TYPE_CAPS, type MaterialGraphDocument, type MaterialType, type PbrSocket } from "./types";
import { readMaterialConfig } from "./compiler";
import { gradientMapFor, matcapFor } from "./material-textures";

// A lookup for the baked channel textures — returns the baked THREE.Texture for a channel, or null when that
// channel wasn't connected/baked. Both TexturedSurface (getChannelTexture) and BakedTextureSet (texture) can
// satisfy this via a one-line adapter.
export interface ChannelTextures {
  get(channel: PbrSocket): THREE.Texture | null;
}

function newClassicMaterial(type: MaterialType): THREE.Material {
  const opts = { side: THREE.DoubleSide };
  switch (type) {
    case "standard":
      return new THREE.MeshStandardMaterial(opts);
    case "lambert":
      return new THREE.MeshLambertMaterial(opts);
    case "phong":
      return new THREE.MeshPhongMaterial(opts);
    case "toon":
      return new THREE.MeshToonMaterial(opts);
    case "matcap":
      return new THREE.MeshMatcapMaterial(opts);
    case "physical":
    default:
      return new THREE.MeshPhysicalMaterial(opts);
  }
}

// Build a CLASSIC (non-node) Three.js material for the document's family, with the baked channel textures
// wired to the standard map slots and every scalar/setting loaded from the document — so a consumer never
// hand-copies config. Reuses the baked textures as-is (they already carry the correct `.colorSpace`:
// baseColor/emission are sRGB, data channels linear). Scalars are set to identity where a map carries the
// value, and to the document's param value where the channel wasn't baked. Gated by MATERIAL_TYPE_CAPS so
// non-PBR families only get the slots they support.
//
// What this deliberately does NOT reproduce (node-only features — use getNodeMaterial() for these): triplanar
// projection, parallax-occlusion mapping (height is not assigned as a classic displacement — expose it via
// the texture-only path if needed), the per-vertex `vertexAo` composition, and procedurally-driven lobes
// without a baked channel (clearcoat/sheen/transmission use their scalar values only).
//
// Note: `.aoMap` samples the mesh's SECOND UV set — replicate uv0→uv1 on the geometry
// (`geometry.setAttribute("uv1", geometry.getAttribute("uv"))`) or ambient occlusion won't apply.
export function buildMeshMaterial(doc: MaterialGraphDocument, textures: ChannelTextures): THREE.Material {
  const cfg = readMaterialConfig(doc);
  const caps = MATERIAL_TYPE_CAPS[cfg.type];
  const material = newClassicMaterial(cfg.type);
  // Per-family classic slots don't all exist on the base Material type; the CAPS/type gating below guarantees
  // we only touch a property the concrete instance actually has (same pattern as compiler.applyBundle).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = material as any;
  const map = (ch: PbrSocket): THREE.Texture | null => textures.get(ch);

  // Base color — map (already sRGB-tagged) with identity tint, else the scalar colour.
  const baseColor = map("baseColor");
  if (baseColor) {
    m.map = baseColor;
    m.color.set(0xffffff);
  } else {
    m.color.set(cfg.baseColor);
  }

  // Tangent-space normal map (baked as 0.5+0.5·n) — directly usable; normalScale stays (1,1).
  const normal = map("normal");
  if (normal) m.normalMap = normal;

  // Alpha is not a baked channel — carry it as opacity/transparency from the param.
  if (cfg.alpha < 1) {
    m.transparent = true;
    m.opacity = cfg.alpha;
  }

  if (caps.ao) {
    const ao = map("ambientOcclusion");
    if (ao) m.aoMap = ao; // NB: samples uv1 (see note above)
  }

  if (caps.emissive) {
    const emission = map("emission");
    if (emission) {
      m.emissiveMap = emission;
      m.emissive.set(0xffffff);
      m.emissiveIntensity = 1;
    } else {
      m.emissive.set(cfg.emission);
    }
  }

  if (caps.roughMetal) {
    const roughness = map("roughness");
    if (roughness) {
      m.roughnessMap = roughness;
      m.roughness = 1; // the map carries the value; don't scale it down
    } else {
      m.roughness = cfg.roughness;
    }
    const metallic = map("metallic");
    if (metallic) {
      m.metalnessMap = metallic;
      m.metalness = 1;
    } else {
      m.metalness = cfg.metallic;
    }
  }

  // Physical lobes have no baked channel — load them as scalars.
  if (caps.physicalLobes) {
    m.ior = cfg.ior;
    m.clearcoat = cfg.coat;
    m.clearcoatRoughness = cfg.coatRoughness;
    m.sheen = cfg.sheen;
    if (cfg.sheen > 0) m.sheenColor.set(0xffffff); // three needs a non-black sheenColor for the lobe to show
    m.sheenRoughness = cfg.sheenRoughness;
    m.transmission = cfg.transmission;
  }

  if (cfg.type === "phong") {
    m.shininess = cfg.shininess;
    m.specular.set(cfg.specular);
  }
  if (cfg.type === "toon") m.gradientMap = gradientMapFor(cfg.gradientSteps);
  if (cfg.type === "matcap") m.matcap = matcapFor(cfg.matcap);

  return material;
}
