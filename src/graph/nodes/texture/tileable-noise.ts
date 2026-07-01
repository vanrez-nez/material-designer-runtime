import { vec2, float, floor, max, mod } from "three/tsl";
import type { MaterialNodeDef, MaterialValue } from "../../types";
import { tileableFbm } from "../../../tsl/tileable-noise";
import { blenderFbm } from "../../../tsl/blender-noise";
import {
  periodicFbm01,
  valueBase01,
  worleyBase01,
  voronoiSmoothBase01,
  paperBase01,
  woolBase01,
  stoneBase01,
  gaborValue2D,
  simplexBase01,
  waveletBase01,
  erosionBase01,
  curlVec,
  type NoiseBase01,
} from "../../../tsl/noise";

type V = MaterialValue;

// Noise types selectable on this node. "perlin-fbm" is the DEFAULT and reproduces the original Tileable
// Noise output verbatim (existing presets are unaffected). The rest are seamless (period-wrapped) variants
// of the @lumiey noise library — each tiles in the offline bake. New types are added here over time.
const NOISE_TYPES = [
  "perlin-fbm",
  "value",
  "worley",
  "voronoi-smooth",
  "gabor",
  "stone",
  "paper",
  "wool",
  "simplex",
  "wavelet",
  "erosion",
  "curl",
];

// Context-sensitive controls per noiseType: which OPTIONAL param keys actually take effect (see paramsFor).
// `noiseType` + `scale` are always shown. fBm types (perlin/value/cellular/flow/simplex/wavelet/erosion) share
// detail/roughness/lacunarity/antialias/tileSize; perlin & value additionally support `aspect` (anisotropic
// per-axis period). `gabor` is sparse convolution — only its freq/aniso/angle (+ tiling). `curl` is a single
// vector sample — nothing but scale (its vector output can't tile). Keys must match the ParamDef keys above.
const FBM_CAPS = ["octaves", "gain", "lacunarity", "antialias", "tileSize"];
const NOISE_CAPS: Record<string, string[]> = {
  "perlin-fbm": ["aspect", ...FBM_CAPS],
  value: ["aspect", ...FBM_CAPS],
  worley: FBM_CAPS,
  "voronoi-smooth": FBM_CAPS,
  stone: FBM_CAPS,
  paper: FBM_CAPS,
  wool: FBM_CAPS,
  simplex: FBM_CAPS,
  wavelet: FBM_CAPS,
  erosion: FBM_CAPS,
  gabor: ["gaborFreq", "gaborAniso", "gaborOrient", "tileSize"],
  curl: [],
};

// Bases for the generic periodic fBm (offline). Cellular/flow types use a single (square) period — they
// ignore `aspect`. perlin-fbm and curl are special-cased (perlin = bespoke tileableFbm; curl = vector output).
const OFFLINE_BASES: Record<string, NoiseBase01> = {
  value: valueBase01,
  worley: worleyBase01,
  "voronoi-smooth": voronoiSmoothBase01,
  // NOTE: gabor is NOT here — it's sparse Gabor convolution with its own frequency/anisotropy/orientation
  // controls (not an fBm base), special-cased in build() like curl/simplex. See gaborValue2D.
  stone: stoneBase01,
  paper: paperBase01,
  wool: woolBase01,
  wavelet: waveletBase01,
  erosion: erosionBase01,
  // NOTE: simplex is NOT here — it needs an EVEN period (see build) so it's special-cased.
};

// curl emits a vector flow field in addition to the scalar magnitude. declare() exposes the extra port.
const FIELD_ONLY = [{ key: "field", kind: "float" as const }];
const FIELD_AND_VECTOR = [
  { key: "field", kind: "float" as const },
  { key: "vector", kind: "vector" as const },
];

// Tileable Noise — periodic fBm that bakes SEAMLESS in the offline backend (authored for the 2D uv tile,
// unlike Blender's 3D noise). `scale` = base period (integer for exact tiling); `aspect` stretches the X
// period for directional grain (perlin only); `octaves` (detail) is a build-time loop unroll; `gain`
// (roughness) is a live uniform. `noiseType` selects the base noise. In the LIVE backend (3D positionWorld,
// no tiling needed) every type falls back to `blenderFbm` as an approximate preview — the offline bake is
// the exact, type-faithful output. Cellular types (worley / voronoi-smooth) use a single square period.
export const tileableNoiseNode: MaterialNodeDef = {
  type: "tileable-noise",
  nodeClass: "texture",
  label: "Tileable Noise",
  // Offline: when `tileSize` is set, the baker renders this noise into a small seamless tile once and repeats
  // it (the noise is periodic over [0,1]) instead of evaluating it across the full grid. See compiler tiling.
  bakeTileable: true,
  inputs: [{ key: "coord", kind: "vector" }],
  outputs: [{ key: "field", kind: "float" }],
  params: [
    { key: "noiseType", label: "type", type: "select", options: NOISE_TYPES, default: "perlin-fbm" },
    // `scale` is a live uniform (float, integer-stepped): the offline bake rounds it to an integer period
    // IN-SHADER (so the lattice still tiles) but reads it as a uniform — a scale edit re-renders the baked
    // channels WITHOUT recompiling (the fast path), and finer grain is reachable at the higher max. It must
    // be `float` (not `int`) because the controller treats every int param as structural (→ full recompile).
    { key: "scale", label: "scale", type: "float", min: 1, max: 128, step: 1, default: 5 },
    // aspect (X-period stretch, perlin/value only) is likewise a live uniform now — no recompile on change.
    { key: "aspect", label: "aspect", type: "float", min: 1, max: 8, step: 0.5, default: 1 },
    { key: "octaves", label: "detail", type: "int", min: 1, max: 8, step: 1, default: 4 },
    { key: "gain", label: "roughness", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 },
    // Lacunarity: the per-octave frequency multiplier. WHOLE numbers only — the offline tile stays seamless
    // only if every octave's period stays integer, so it's a build-time value (bakeStructural → re-bake on
    // change, not a live tweak). 2 = the classic octave. Live (3D) reads it as a continuous uniform.
    { key: "lacunarity", label: "lacunarity", type: "float", min: 2, max: 8, step: 1, default: 2, bakeStructural: true },
    // Band-limit (anti-alias) strength, live uniform. 1 = fade octaves finer than the bake texel grid so the
    // noise stays crisp instead of aliasing into speckle/mush (offline only); 0 = the raw, unfiltered sum.
    { key: "antialias", label: "anti-alias", type: "float", min: 0, max: 1, step: 0.01, default: 1 },
    // Gabor-only live uniforms (faithful Blender Gabor Texture; ignored by every other noiseType). frequency =
    // oscillations across a kernel (perpendicular to the direction); anisotropy 1 = directional stripes, 0 =
    // omnidirectional; angle = the base orientation in radians. See gaborValue2D.
    { key: "gaborFreq", label: "gabor freq", type: "float", min: 0, max: 16, step: 0.1, default: 2 },
    { key: "gaborAniso", label: "gabor aniso", type: "float", min: 0, max: 1, step: 0.01, default: 1 },
    { key: "gaborOrient", label: "gabor angle", type: "float", min: 0, max: 6.2832, step: 0.01, default: 0.785398 },
    // Tiling (offline only): "off" = evaluate the noise across the full grid (default, unchanged). A px value
    // renders a REPEATING BLOCK — the noise fills a tileSize² seamless tile at full pixel density and repeats
    // it (repeat = outputResolution/tileSize) to cover the texture. Feature size and crispness are UNCHANGED
    // (same as "off"); the only difference is the pattern repeats, and only tileSize² unique texels are
    // computed (cheaper). Smaller tile = more visible repetition. Structural (select) → editing re-bakes.
    // `curl` (vector) output is never tiled.
    { key: "tileSize", label: "tile", type: "select", options: ["off", "64", "128", "256", "512"], default: "off" },
  ],
  // curl adds a `vector` output (the flow field); all other types expose just `field`.
  declare(params) {
    const inputs = [{ key: "coord", kind: "vector" as const }];
    return {
      inputs,
      outputs: (params.noiseType as string) === "curl" ? FIELD_AND_VECTOR : FIELD_ONLY,
    };
  },
  // Context-sensitive controls: show `noiseType` + `scale` always, then only the params that take effect for
  // the selected noiseType (see NOISE_CAPS). Editor-only filter — the compiler still builds every uniform.
  paramsFor(params) {
    const caps = NOISE_CAPS[(params.noiseType as string) ?? "perlin-fbm"] ?? [];
    const show = new Set(["noiseType", "scale", ...caps]);
    return tileableNoiseNode.params.filter((p) => show.has(p.key));
  },
  build(ctx) {
    const coord = (ctx.inputs.coord ?? ctx.coord) as V;
    // Guard against a non-finite octaves field (empty editor input → NaN): octaves is a build-time loop
    // count, so a bad value here would just unroll wrong — clamp it. (scale/aspect are uniforms now; the
    // compiler already NaN-guards uniform seeds, so no build-time coercion is needed for them.)
    const octaves = Math.max(1, Math.round(Number.isFinite(Number(ctx.params.octaves)) ? Number(ctx.params.octaves) : 4));
    // Lacunarity is a build-time WHOLE number offline (integer octave periods → seamless tiling); rounded here.
    const lac = Math.max(2, Math.round(Number.isFinite(Number(ctx.params.lacunarity)) ? Number(ctx.params.lacunarity) : 2));
    const noiseType = (ctx.params.noiseType as string) ?? "perlin-fbm";
    const gain = ctx.uniforms.gain as V;
    const scaleU = ctx.uniforms.scale as V; // live uniform (float)

    if (ctx.backend === "live") {
      // No tiling in the seamless-3D preview; reuse the Blender fBm over the world coordinate for every type.
      // scale stays a continuous live uniform here (no integer period needed off the tile). Lacunarity is a
      // continuous live uniform here (the integer constraint only applies to the seamless offline tile).
      const p = coord.mul(scaleU) as V;
      return { field: blenderFbm(p, octaves, gain, ctx.uniforms.lacunarity as V) };
    }

    const uv2 = vec2(coord.x, coord.y) as V;
    const aaU = ctx.uniforms.antialias as V; // live band-limit strength (0..1)
    // Repeating-unit tiling (offline): the compiler renders `period / tileRepeat` periods into a small buffer
    // and repeats it ×tileRepeat, so dividing the period here keeps the final feature size = `scale` (constant)
    // while the block repeats. 1 = no tiling (full render). See compiler maybeTileNode / tileRepeatFor.
    const tileRepeat = Math.max(1, Math.round(ctx.tileRepeat ?? 1));
    const scaleTiled = tileRepeat > 1 ? (scaleU.div(float(tileRepeat)) as V) : scaleU;
    // Offline tiling needs an INTEGER cell count; round the (tile-divided) scale uniform to a whole period
    // IN-SHADER (so a scale drag re-renders without recompiling, yet the lattice at index `period` matches 0).
    const periodU = max(floor(scaleTiled.add(0.5)), float(1)) as V;
    // aspect stretches the X period (perlin/value); keep it integer so X tiles too.
    const aspectU = ctx.uniforms.aspect as V;
    const periodXU = max(floor(periodU.mul(aspectU).add(0.5)), float(1)) as V;

    if (noiseType === "curl") {
      // Vector flow field (single sample at the base period); `field` = its magnitude.
      const c = curlVec(uv2.mul(periodU), periodU, periodU) as V;
      return { field: c.length(), vector: c };
    }

    if (noiseType === "simplex") {
      // psrdnoise's sheared simplex lattice only tiles in Y when the period is EVEN — an odd period shifts
      // the skewed x-index by a half cell across the y-wrap, leaving a vertical seam. Snap the period up to
      // even (every octave period stays even since it's ×2^o): even = period + (period mod 2).
      const evenU = periodU.add(mod(periodU, float(2))) as V;
      return { field: periodicFbm01(uv2, evenU, evenU, octaves, gain, simplexBase01, aaU, lac) };
    }

    if (noiseType === "gabor") {
      // Faithful Blender Gabor (sparse convolution) — its own frequency/anisotropy/orientation controls; it is
      // NOT an fBm base, so octaves/gain/aspect/antialias don't apply. isotropy = 1 − anisotropy. `periodU`
      // (integer scale, tile-divided) sets the cell count so it stays seamless + tileable.
      const isotropy = float(1).sub(ctx.uniforms.gaborAniso as V) as V;
      return {
        field: gaborValue2D(uv2, periodU, ctx.uniforms.gaborFreq as V, isotropy, ctx.uniforms.gaborOrient as V),
      };
    }

    const base = OFFLINE_BASES[noiseType];
    if (base) {
      // Cellular/flow types ignore aspect (square period); value supports it (anisotropic per-axis period).
      const periodX = noiseType === "value" ? periodXU : periodU;
      return { field: periodicFbm01(uv2, periodX, periodU, octaves, gain, base, aaU, lac) };
    }
    // Default "perlin-fbm": original bespoke path — periodic fBm over the uv tile. aspect elongates along Y.
    const n = tileableFbm(uv2, periodXU, periodU, octaves, gain, aaU, lac);
    return { field: n.mul(0.5).add(0.5) }; // [-1,1] → [0,1]
  },
};
