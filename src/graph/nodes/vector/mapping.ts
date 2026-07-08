import type { MaterialNodeDef } from "../../types";
import { blenderMapping } from "../../../tsl/blender-mapping";

const TYPES = ["point", "texture", "vector", "normal"];

// Mapping (Blender ShaderNodeMapping) — transforms a coordinate by location/rotation/scale. The canonical
// "position/scale/rotate your texture" node (faithful port in tsl/blender-mapping.ts). `vector` defaults
// to the global coordinate when unconnected; location/rotation(radians)/scale are vec3 params; type is a
// build-time select. Wire its output into a texture's `coord`.
export const mappingNode: MaterialNodeDef = {
  type: "mapping",
  nodeClass: "vector",
  label: "Mapping",
  inputs: [{ key: "vector", kind: "vector" }],
  outputs: [{ key: "vector", kind: "vector" }],
  params: [
    { key: "mappingType", label: "type", type: "select", options: TYPES, default: "point" },
    { key: "location", label: "location", type: "vec3", default: { x: 0, y: 0, z: 0 } },
    { key: "rotation", label: "rotation", type: "vec3", default: { x: 0, y: 0, z: 0 } },
    { key: "scale", label: "scale", type: "vec3", default: { x: 1, y: 1, z: 1 } },
  ],
  build(ctx) {
    const v = ctx.inputs.vector ?? ctx.coord;
    const type = Math.max(0, TYPES.indexOf(ctx.constant("mappingType") as string));
    return {
      vector: blenderMapping(v, ctx.live("location"), ctx.live("rotation"), ctx.live("scale"), type),
    };
  },
};
