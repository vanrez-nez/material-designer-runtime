import { float, vec2, vec3, sin, floor, round } from "three/tsl";
import { blenderFbm } from "./blender-noise";
import { tileableFbm } from "./tileable-noise";
import type { MaterialValue } from "../graph/types";

// Faithful TSL port of Blender's Wave Texture (Fac output) — plan L4. Transcribed verbatim from
// gpu_shader_material_tex_wave.glsl `calc_wave`. Bands/Rings × Sine/Saw/Triangle, with optional fBm
// distortion (reuses the faithful Noise port). Modes are build-time selects; phase/distortion/detail
// scale+roughness are live uniforms; detail (octaves) is a build-time loop count. Verified against a
// pure-JS port of the same function.
//
// Offline tiling (opts.tileable): the faithful path is a 3D field that doesn't wrap, so a bake seams. In
// the offline backend both wave types get a seamless variant; over an integer coordinate span (an integer
// Mapping scale on the uv tile) the result wraps. Mirrors the Voronoi fix.
//   - BANDS: the band frequency is snapped to an integer number of cycles per unit coordinate, and the
//     distortion fBm is replaced by a periodic one (tileableFbm, period 1 per unit).
//   - RINGS: a single concentric pattern is radial and can't tile, so the radius becomes the distance to
//     the nearest integer lattice point — a periodic grid of ring cells, continuous at the shared cell
//     edges/corners (no value seam; the only artefact is the natural crease where neighbouring cells meet).
// Both distortions use the periodic tileableFbm so the wave stays seamless when distortion is on.
type V = MaterialValue;
const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
// Blender's band slopes: bands multiply the axis by 20; the diagonal sums the axes and multiplies by 10.
const BAND_MUL = 20;
const DIAG_MUL = 10;

export interface WaveOpts {
  waveType: number; // 0 bands, 1 rings
  dir: number; // 0 x, 1 y, 2 z, 3 diagonal/spherical
  profile: number; // 0 sine, 1 saw, 2 triangle
  withDistortion: boolean; // gate the fBm term (skip when distortion param is 0)
  detail: number; // fBm octaves (build-time)
  tileable: boolean; // offline: emit the seamless bands variant (see header)
  scaleNum: number; // build-time scale, for the integer frequency snap (tileable path)
  detailScaleNum: number; // build-time detail scale, for the periodic-distortion integer period
}

function applyProfile(n: V, profile: number): V {
  if (profile === 0) return float(0.5).add(sin(n.sub(HALF_PI)).mul(0.5)); // sine
  if (profile === 1) {
    const m = n.div(TAU);
    return m.sub(floor(m)); // saw
  }
  const m = n.div(TAU);
  return m.sub(floor(m.add(0.5))).abs().mul(2); // triangle
}

// Seamless bands for the offline bake. Frequency is an integer cycle-count per unit coordinate, so over an
// integer coordinate span the sine completes whole cycles; the distortion uses a periodic fBm (period 1 per
// unit). `coord` is the (mapped) texture coordinate — use an integer Mapping scale on the uv tile to tile.
function tileableBands(coord: V, phase: V, distortion: V, detailRoughness: V, opts: WaveOpts): V {
  const cyc = Math.max(1, Math.round((opts.scaleNum * BAND_MUL) / TAU)); // bands: integer cycles / unit
  const dcyc = Math.max(1, Math.round((opts.scaleNum * DIAG_MUL) / TAU)); // diagonal: idem on (x+y+z)
  let n: V;
  if (opts.dir === 0) n = coord.x.mul(cyc * TAU);
  else if (opts.dir === 1) n = coord.y.mul(cyc * TAU);
  else if (opts.dir === 2) n = coord.z.mul(cyc * TAU);
  else n = coord.x.add(coord.y).add(coord.z).mul(dcyc * TAU);
  n = n.add(phase);
  if (opts.withDistortion) {
    // Periodic fBm for the distortion → wraps every unit coordinate, matching the integer tile span (so it
    // tiles). ANISOTROPIC by band direction: the distortion should vary across the bands but stay coherent
    // along them — otherwise the bands ripple along their length and read as a woven/ribbed pattern rather
    // than grain. So the across-axis gets the detail period and the along-axis gets 1 (smooth). tileableFbm
    // already returns ~[-1,1] (no *2-1 remap).
    const dp = Math.max(1, Math.round(opts.scaleNum * opts.detailScaleNum));
    // Along-grain period 2 = a single gentle undulation over the tile (the flame/cathedral wave) without
    // the ribbing that higher along-grain frequencies produce.
    const along = 2;
    let px = dp;
    let py = dp;
    if (opts.dir === 0) py = along; // bands in x → grain runs in y
    else if (opts.dir === 1) px = along; // bands in y → grain runs in x
    const tfbm = tileableFbm(vec2(coord.x, coord.y), px, py, Math.max(1, opts.detail), detailRoughness);
    n = n.add(distortion.mul(tfbm));
  }
  return applyProfile(n, opts.profile);
}

// Seamless rings for the offline bake. The radius is the distance to the nearest integer lattice point
// (period 1 in coord), giving a tiling grid of concentric ring cells; that distance is periodic for ANY
// frequency, so `scale` stays a live uniform (no snap). The zeroed axis follows Blender's rings direction
// (x → yz plane, y → xz, z/spherical → full); in the offline uv slice coord.z is 0, so x/y collapse to a
// single-axis (band-like) distance and z/spherical give true 2D rings.
function tileableRings(coord: V, scale: V, phase: V, distortion: V, detailRoughness: V, opts: WaveOpts): V {
  const nearest = (a: V): V => a.sub(round(a)); // offset to nearest lattice point ∈ [-0.5, 0.5]
  let rel: V;
  if (opts.dir === 0) rel = vec3(float(0), nearest(coord.y), nearest(coord.z));
  else if (opts.dir === 1) rel = vec3(nearest(coord.x), float(0), nearest(coord.z));
  else if (opts.dir === 2) rel = vec3(nearest(coord.x), nearest(coord.y), float(0));
  else rel = vec3(nearest(coord.x), nearest(coord.y), nearest(coord.z));
  let n: V = rel.length().mul(scale).mul(BAND_MUL).add(phase);
  if (opts.withDistortion) {
    const dp = Math.max(1, Math.round(opts.scaleNum * opts.detailScaleNum));
    const tfbm = tileableFbm(vec2(coord.x, coord.y), dp, dp, Math.max(1, opts.detail), detailRoughness);
    n = n.add(distortion.mul(tfbm));
  }
  return applyProfile(n, opts.profile);
}

export function blenderWave(
  coord: V,
  scale: V,
  phase: V,
  distortion: V,
  detailScale: V,
  detailRoughness: V,
  opts: WaveOpts,
): V {
  // Offline seamless path for both wave types.
  if (opts.tileable) {
    return opts.waveType === 0
      ? tileableBands(coord, phase, distortion, detailRoughness, opts)
      : tileableRings(coord, scale, phase, distortion, detailRoughness, opts);
  }
  const p = coord.mul(scale).add(0.000001).mul(0.999999);
  let n: V;
  if (opts.waveType === 0) {
    // bands
    if (opts.dir === 0) n = p.x.mul(BAND_MUL);
    else if (opts.dir === 1) n = p.y.mul(BAND_MUL);
    else if (opts.dir === 2) n = p.z.mul(BAND_MUL);
    else n = p.x.add(p.y).add(p.z).mul(DIAG_MUL);
  } else {
    // rings
    let rp: V = p;
    if (opts.dir === 0) rp = p.mul(vec3(0, 1, 1));
    else if (opts.dir === 1) rp = p.mul(vec3(1, 0, 1));
    else if (opts.dir === 2) rp = p.mul(vec3(1, 1, 0));
    n = rp.length().mul(BAND_MUL);
  }
  n = n.add(phase);
  if (opts.withDistortion) {
    // noise_fbm(p*detail_scale, detail, detail_roughness, lacunarity=2, normalize=true) * 2 - 1
    const fbm = blenderFbm(p.mul(detailScale), opts.detail, detailRoughness, float(2));
    n = n.add(distortion.mul(fbm.mul(2).sub(1)));
  }
  return applyProfile(n, opts.profile);
}
