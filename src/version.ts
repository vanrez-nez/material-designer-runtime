// Derived from package.json, deliberately — this used to be a hand-maintained copy, which meant every release
// had two places to bump and a build that failed when you missed one.
//
// It exists for the bake cache: node maths changes texel output without touching the document schema (e.g.
// "increase maximum scale for Voronoi", "height blend analytic anti-aliasing" — all shipped without a
// MATERIAL_DOCUMENT_VERSION bump). Folding the package version into the cache key means an upgrade orphans
// every cached bake instead of silently restoring pre-fix texels. A cold cache after an upgrade is the
// correct trade.
//
// The named import is what keeps this honest: bundlers tree-shake it to the version string alone, so none of
// package.json's other contents reach the shipped bundle.
import { version } from "../package.json";

export const MATERIAL_RUNTIME_VERSION: string = version;
