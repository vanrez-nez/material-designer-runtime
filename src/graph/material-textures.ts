import * as THREE from "three";

// Synthesized textures for the material families that need one but have no asset pipeline yet (Toon's
// gradient map, Matcap's matcap). Shared by both the node-material factory (compiler.newSurfaceMaterial)
// and the classic-material builder (mesh-material.buildMeshMaterial) so the two stay in lock-step.

// Toon gradient map: a 1×N greyscale ramp (evenly-spaced luminance bands) that MeshToon samples by N·L to
// quantize diffuse into cel bands. NearestFilter keeps the steps hard. Memoized per band count so cycling
// `gradientSteps` doesn't leak textures. There's no asset pipeline yet — this synthesizes the recognizable
// toon look in-code; a real gradient-image loader is a later enhancement.
const gradientCache = new Map<number, THREE.DataTexture>();
export function gradientMapFor(steps: number | undefined): THREE.DataTexture {
  const n = Math.max(2, Math.min(5, Math.round(steps ?? 3)));
  const cached = gradientCache.get(n);
  if (cached) return cached;
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = Math.round((i / (n - 1)) * 255);
  const tex = new THREE.DataTexture(data, n, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  gradientCache.set(n, tex);
  return tex;
}

// Matcap texture: v1 has no asset pipeline, so only the built-in fallback is supported — returning null
// lets MeshMatcap(Node)Material use its own vec3(mix(0.2,0.8,uv.y)) gradient (a valid shaded look). Non-
// "default" ids are reserved for a future procedural/loaded matcap library and fall back to null for now.
export function matcapFor(_id: string | undefined): THREE.Texture | null {
  return null;
}
