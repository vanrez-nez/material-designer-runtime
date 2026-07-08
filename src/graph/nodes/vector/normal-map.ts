import { normalMap, vec3 } from "three/tsl";
import type { MaterialNodeDef } from "../../types";

// Normal Map (Blender ShaderNodeNormalMap, Tangent space). Decodes a tangent-space normal map colour and
// transforms it by the surface TBN into the view-space normal `material.normalNode` expects (same space
// as our bumpMap-based Normal From Height). TSL `normalMap(color, strength)` does the *2-1 unpack, the
// xy strength scale, and the TBNViewMatrix multiply. Uses the mesh's per-corner tangents.
//
// Limitation: like all normal output, this only round-trips in the LIVE surface render — the baked
// (uv-quad) context has no mesh tangents, so a baked 'normal' channel here isn't meaningful (consistent
// with the compiler leaving normal procedural).
export const normalMapNode: MaterialNodeDef = {
  type: "normal-map",
  nodeClass: "vector",
  label: "Normal Map",
  inputs: [
    { key: "color", label: "Color", kind: "color" },
    { key: "strength", label: "Strength", kind: "float" },
  ],
  outputs: [{ key: "normal", kind: "vector" }],
  params: [{ key: "strength", label: "strength", type: "float", min: 0, max: 4, step: 0.05, default: 1 }],
  build(ctx) {
    // Default is a flat tangent-space normal (0.5, 0.5, 1) → decodes to (0,0,1) → unperturbed.
    const color = ctx.inputs.color ?? vec3(0.5, 0.5, 1);
    const strength = ctx.inputs.strength ?? ctx.live("strength");
    return { normal: normalMap(color, strength) };
  },
};
