// Procedural noise library (@lumiey-inspired), ported to TSL with SEAMLESS (period-wrapped) variants for the
// offline bake. See hash.ts for the periodic-hashing rationale. The existing tileable-noise.ts / blender-noise.ts
// primitives are the defaults and are intentionally NOT re-exported here.
export { periodicFbm01, type NoiseBase01 } from "./fbm";
export { valueBase01 } from "./value";
export { worleyBase01, voronoiSmoothBase01 } from "./cellular";
export { curlVec, paperBase01, woolBase01, stoneBase01 } from "./flow";
export { gaborValue2D } from "./gabor";
export { simplexBase01 } from "./simplex";
export { waveletBase01 } from "./wavelet";
export { erosionBase01 } from "./erosion";
