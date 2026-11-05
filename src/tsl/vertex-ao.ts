import { Fn, attribute, float } from "three/tsl";
import type { MaterialValue } from "../graph/types";

// Per-vertex FORM AO, read from the optional `vertexAo` geometry attribute. When a geometry doesn't carry
// it, three's AttributeNode would substitute a constant 0, which zeroes aoNode and kills all indirect light.
// The branch is resolved at build time against the geometry being compiled; three keys render-object
// programs by the geometry's attribute names, so meshes with and without the attribute get separate programs.
const VERTEX_AO = "vertexAo";

export const vertexAo = Fn((builder): MaterialValue =>
  builder.hasGeometryAttribute(VERTEX_AO) ? attribute(VERTEX_AO, "float") : float(1),
);
