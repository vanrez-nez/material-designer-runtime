import { uniformArray, int, float, floor, max } from "three/tsl";
import { Vector3 } from "three";
import type { MaterialNodeDef, MaterialValue, PortDef } from "../../types";
import {
  blenderVoronoiF1,
  blenderVoronoiF1Color,
  blenderVoronoiF1Pos,
  blenderVoronoiF2,
  blenderVoronoiF2Color,
  blenderVoronoiF2Pos,
  blenderVoronoiSmoothF1,
  blenderVoronoiSmoothF1Color,
  blenderVoronoiSmoothF1Pos,
  blenderVoronoiDistanceToEdge,
} from "../../../tsl/blender-voronoi";
import { relaxedCellOffsets } from "../../../tsl/lloyd-points";
import { relaxedVoronoiDistanceToEdge, relaxedVoronoiCellValue } from "../../../tsl/relaxed-voronoi";

const METRICS = ["euclidean", "manhattan", "chebychev", "minkowski"];
const FEATURES = ["f1", "f2", "smooth-f1", "distance-to-edge"];

// Feature-dependent outputs (declare()): F1/F2/Smooth-F1 expose Distance/Color/Position; Distance-to-Edge
// exposes only Distance.
const FULL_OUTPUTS: PortDef[] = [
  { key: "distance", label: "Distance", kind: "float" },
  { key: "color", label: "Color", kind: "color" },
  { key: "position", label: "Position", kind: "vector" },
];
// Distance-to-Edge has no per-cell Colour output, so it carries a scalar per-cell `Random` instead — one
// constant value per cell (for per-tile tint variation), aligned to the (relaxed) cell tessellation.
const EDGE_OUTPUTS: PortDef[] = [
  { key: "distance", label: "Distance", kind: "float" },
  { key: "random", label: "Random", kind: "float" },
];
const COORD_INPUT: PortDef[] = [{ key: "coord", kind: "vector" }];

// Deterministic per-cell random in [0,1] (stable across bakes). Indexed by the cell's linear id; the array
// IS the tile period, so wrapped lookups repeat seamlessly across the bake-tile edge.
function cellRandomValues(count: number): number[] {
  const out = new Array<number>(count);
  for (let n = 0; n < count; n++) {
    const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    out[n] = s - Math.floor(s);
  }
  return out;
}

// Voronoi Texture (Blender ShaderNodeTexVoronoi) — faithful Blender port (PCG cell hash + neighbour search
// in tsl/blender-voronoi.ts). `scale` multiplies the domain; `randomness`/`exponent`/`smoothness` are live
// uniforms; `metric` and `feature` are build-time selects. `declare()` makes the outputs follow the
// feature (Phase 5). Exponent applies to the Minkowski metric; smoothness to Smooth F1.
export const voronoiNode: MaterialNodeDef = {
  type: "voronoi",
  nodeClass: "texture",
  label: "Voronoi",
  inputs: COORD_INPUT,
  outputs: FULL_OUTPUTS,
  params: [
    // scale is a LIVE uniform: offline rounds it to an integer period IN-SHADER (still tiles), so a scale
    // drag re-renders the baked channels without recompiling and finer grain is reachable at the higher max.
    // Live (3D) uses it as a continuous multiplier. EXCEPTION: the relaxed distance-to-edge path bakes scale
    // (and randomness) into CPU Lloyd seeds at build time — see build() — so live edits to those two only
    // re-tessellate after a structural change (e.g. toggling `relax`/`feature`).
    { key: "scale", label: "scale", type: "float", min: 0.1, max: 64, step: 0.05, default: 1 },
    { key: "randomness", label: "randomness", type: "float", min: 0, max: 1, step: 0.01, default: 1 },
    { key: "metric", label: "metric", type: "select", options: METRICS, default: "euclidean" },
    { key: "feature", label: "feature", type: "select", options: FEATURES, default: "f1" },
    { key: "exponent", label: "exponent", type: "float", min: 0.1, max: 8, step: 0.1, default: 2 },
    { key: "smoothness", label: "smoothness", type: "float", min: 0, max: 1, step: 0.01, default: 0.25 },
    // Lloyd relaxation iterations for natural (centroidal) cells — offline + distance-to-edge only. 0 keeps
    // the faithful jittered-grid Voronoi; 2–4 give equiaxed, sliver-free, non-square mud-crack cells.
    { key: "relax", label: "relax", type: "int", min: 0, max: 5, step: 1, default: 0 },
  ],
  declare(params) {
    const feature = (params.feature as string) ?? "f1";
    return { inputs: COORD_INPUT, outputs: feature === "distance-to-edge" ? EDGE_OUTPUTS : FULL_OUTPUTS };
  },
  // Context-sensitive controls: `exponent` only affects the Minkowski metric, `smoothness` only Smooth-F1, and
  // `relax` (Lloyd) only the distance-to-edge feature (offline). Hide the ones that do nothing in the current
  // mode. Editor-only filter — the compiler still builds every uniform (harmless when unused).
  paramsFor(params) {
    const metric = (params.metric as string) ?? "euclidean";
    const feature = (params.feature as string) ?? "f1";
    const show = new Set(["scale", "randomness", "metric", "feature"]);
    if (metric === "minkowski") show.add("exponent");
    if (feature === "smooth-f1") show.add("smoothness");
    if (feature === "distance-to-edge") show.add("relax");
    return voronoiNode.params.filter((p) => show.has(p.key));
  },
  build(ctx) {
    const offline = ctx.backend === "offline";
    const m = Math.max(0, METRICS.indexOf(ctx.params.metric as string));
    const r = ctx.uniforms.randomness;
    const e = ctx.uniforms.exponent;
    const s = ctx.uniforms.smoothness;
    const feature = (ctx.params.feature as string) ?? "f1";
    const coordIn = ctx.inputs.coord ?? ctx.coord;

    // Lloyd-relaxed cells: offline + distance-to-edge only. Precompute a periodic relaxed seed set on the
    // CPU (sized period²) and hand it to the shader as a uniformArray; the relaxed neighbour search reads
    // those offsets instead of the PCG hash (same cost, GPU-safe). Because the seed array is sized by the
    // period, `scale` (→ period) and `randomness` (→ initial jitter) are BUILD-TIME here — a live edit to
    // either only re-tessellates after a structural change (e.g. toggling `relax`), unlike the paths below.
    const relax = Math.max(0, Math.round(Number(ctx.params.relax ?? 0)));
    if (feature === "distance-to-edge" && offline && relax > 0) {
      const period = Math.max(1, Math.round(Number(ctx.params.scale ?? 1)));
      const p = coordIn.mul(period);
      const data = relaxedCellOffsets(period, Number(ctx.params.randomness ?? 1), relax);
      const vecs: Vector3[] = [];
      for (let n = 0; n < period * period; n++)
        vecs.push(new Vector3(data[n * 3], data[n * 3 + 1], data[n * 3 + 2]));
      const seeds = uniformArray(vecs);
      const wrap = (v: MaterialValue): MaterialValue =>
        v.sub(int(floor(float(v).div(period))).mul(int(period)));
      const seedFn = (ix: MaterialValue, iy: MaterialValue): MaterialValue =>
        seeds.element(wrap(iy).mul(period).add(wrap(ix))) as MaterialValue;
      // Per-cell random tint: same relaxed seeds, so it lines up with the crack cells exactly.
      const randoms = uniformArray(cellRandomValues(period * period));
      const valueFn = (ix: MaterialValue, iy: MaterialValue): MaterialValue =>
        randoms.element(wrap(iy).mul(period).add(wrap(ix))) as MaterialValue;
      return {
        distance: relaxedVoronoiDistanceToEdge(p, seedFn),
        random: relaxedVoronoiCellValue(p, seedFn, valueFn),
      };
    }

    // Offline bakes a 2D uv tile: round the LIVE scale uniform to an INTEGER period in-shader and wrap the
    // cell hash to it so the cells repeat seamlessly across the tile edge — yet a scale edit re-renders
    // without recompiling. Live is a seamless 3D field (positionWorld): period 0 keeps the faithful Blender
    // path, scaled by the raw (continuous) scale uniform.
    const scaleU = ctx.uniforms.scale as MaterialValue;
    const periodU = max(floor(scaleU.add(0.5)), float(1)) as MaterialValue;
    const p = coordIn.mul(offline ? periodU : scaleU);
    const period: number | MaterialValue = offline ? periodU : 0;

    switch (feature) {
      case "distance-to-edge":
        // Un-relaxed distance-to-edge shares the jittered-grid seeds with F1, so F1's per-cell colour hash
        // aligns with these cells — use its red channel as the per-cell random.
        return {
          distance: blenderVoronoiDistanceToEdge(p, r, period),
          random: blenderVoronoiF1Color(p, r, m, e, period).x,
        };
      case "f2":
        return {
          distance: blenderVoronoiF2(p, r, m, e, period),
          color: blenderVoronoiF2Color(p, r, m, e, period),
          position: blenderVoronoiF2Pos(p, r, m, e, period),
        };
      case "smooth-f1":
        return {
          distance: blenderVoronoiSmoothF1(p, r, m, e, s, period),
          color: blenderVoronoiSmoothF1Color(p, r, m, e, s, period),
          position: blenderVoronoiSmoothF1Pos(p, r, m, e, s, period),
        };
      default:
        return {
          distance: blenderVoronoiF1(p, r, m, e, period),
          color: blenderVoronoiF1Color(p, r, m, e, period),
          position: blenderVoronoiF1Pos(p, r, m, e, period),
        };
    }
  },
};
