import { uniform, wgslFn } from "three/tsl";
import type { ShaderVariant } from "./shader-variant";

// A benchmark-only shader identity. Three caches programs by their generated shader source and Chromium's
// GPU process can retain compiled shader/pipeline data across a page reload. Routing a value through one of
// these identity functions changes the actual WGSL for every benchmark run without changing its pixels.
//
// This is intentionally opt-in. Normal editor/runtime consumers should keep shader reuse enabled.
export type ShaderCacheBuster = ShaderVariant;

function wgslIdentifier(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 96);
  return normalized || "run";
}

function guardCoefficient(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  // A finite, non-zero f32 literal. Its value changes the compiler IR between runs, while the runtime guard
  // remains zero. This keeps a backend from normalizing away a cache bust based only on renamed functions.
  return (((hash % 9_000_000) + 1_000_000) / 10_000_000).toFixed(7);
}

export function createShaderCacheBuster(nonce?: string): ShaderCacheBuster | null {
  if (!nonce) return null;
  const id = wgslIdentifier(nonce);
  const coefficient = guardCoefficient(nonce);
  const zeroGuard = uniform(0);
  const scalarIdentity = wgslFn(`
    fn md_cold_scalar_${id}(value: f32, guard: f32) -> f32 {
      return value + guard * ${coefficient};
    }
  `);
  const vec3Identity = wgslFn(`
    fn md_cold_vec3_${id}(value: vec3<f32>, guard: f32) -> vec3<f32> {
      return value + vec3<f32>(guard * ${coefficient});
    }
  `);

  return {
    key: nonce,
    scalar: (value) => scalarIdentity({ value, guard: zeroGuard }),
    vec3: (value) => vec3Identity({ value, guard: zeroGuard }),
  };
}
