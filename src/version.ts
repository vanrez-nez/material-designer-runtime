// This package's version, as a build-time constant.
//
// It exists for the bake cache: node maths changes texel output without touching the document schema
// (e.g. "increase maximum scale for Voronoi", "height blend analytic anti-aliasing", "add tilt/formRandom/
// erode to shapeNode" — all shipped without a MATERIAL_DOCUMENT_VERSION bump). Folding this into the cache
// key means an upgrade orphans every cached bake instead of silently restoring pre-fix texels. A cold cache
// after an upgrade is the correct trade.
//
// MUST match package.json's `version` — `test/bake-cache.test.ts` asserts it, so a release bump that forgets
// this file fails the suite rather than serving stale textures.
export const MATERIAL_RUNTIME_VERSION = "0.1.4";
