import { uv, vec3, float, positionLocal, normalLocal } from "three/tsl";
import type { MaterialNodeDef } from "../../types";

// Texture Coordinate (Blender ShaderNodeTexCoord) — coordinate sources to drive textures / Mapping.
//
// Structural limitation (three.js render context, surfaced per the plan): the non-UV sources
// (Generated/Object/Normal) are mesh-local TSL globals that only exist while rendering the actual
// surface. In the BAKED backend the channel-baker draws a fullscreen uv quad — there is no mesh — so
// every source collapses to the uv slice. UV is always real. `Generated` is object-space `positionLocal`
// (not the [0,1] bbox-normalized coordinate Blender's Generated returns — we have no bbox here).
export const texCoordNode: MaterialNodeDef = {
  type: "tex-coordinate",
  nodeClass: "input",
  label: "Texture Coordinate",
  inputs: [],
  outputs: [
    { key: "generated", label: "Generated", kind: "vector" },
    { key: "uv", label: "UV", kind: "vector" },
    { key: "object", label: "Object", kind: "vector" },
    { key: "normal", label: "Normal", kind: "vector" },
  ],
  params: [],
  build(ctx) {
    const uvCoord = vec3(uv().x, uv().y, float(0));
    if (ctx.backend === "offline") {
      // No mesh in the uv-quad bake context — all sources collapse to the uv slice.
      return { generated: uvCoord, uv: uvCoord, object: uvCoord, normal: uvCoord };
    }
    return { generated: positionLocal, uv: uvCoord, object: positionLocal, normal: normalLocal };
  },
};
