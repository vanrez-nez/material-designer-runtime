import type { MaterialValue } from "./types";

// Optional shader identity/decoration seam. The runtime does not provide or install a variant; tooling can
// supply one from a separate entry point without pulling that implementation into the production bundle.
export interface ShaderVariant {
  key: string;
  scalar(value: MaterialValue): MaterialValue;
  vec3(value: MaterialValue): MaterialValue;
}
