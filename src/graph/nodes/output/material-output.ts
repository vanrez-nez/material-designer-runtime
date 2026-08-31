import type { MaterialNodeDef } from "../../types";

// Terminal node (Blender's Material Output). Singleton, non-deletable, no outputs. Its single Surface
// input takes the constrained green Shader marker from a Principled BSDF / Emission node; the compiler
// reads the bundle carried on that input and unpacks it onto the MeshPhysicalNodeMaterial. build()
// returns nothing. (Volume / Displacement outputs are out of scope — plan L1/L2.)
//
// `outputResolution` = the pixel size of the EXPORT bake's final channel textures, authored per graph (the
// export path reads it; a request `size` still overrides, and the live preview stays at its own small size
// for edit speed). It's a `select` → structural → editing it re-bakes. (A `quality` degrade knob lands here
// in a later phase.)
export const materialOutputNode: MaterialNodeDef = {
  type: "material-output",
  nodeClass: "output",
  label: "Material Output",
  inputs: [{ key: "surface", label: "Surface", kind: "shader" }],
  outputs: [],
  params: [
    {
      key: "outputResolution",
      label: "output res",
      type: "select",
      options: ["128", "256", "512", "1024", "2048", "4096"],
      default: "1024",
    },
    // Pack AO / roughness / metalness / height into ONE ARMH texture (R=AO, G=roughness, B=metalness —
    // three.js's native aoMap/roughnessMap/metalnessMap convention — plus A=height when the graph drives
    // height). Channel-texture queries then return the same shared texture for all three field sockets (and
    // the height query resolves to it too). `bool` → structural → toggling re-bakes. Default ON; sparse
    // documents (every pre-existing preset) read as ON via readArmPacking.
    { key: "packArm", label: "pack ARMH", type: "bool", default: true },
  ],
  build() {
    return {};
  },
};
