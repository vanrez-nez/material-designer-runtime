import { Fn, Loop, float, int, vec2, vec3, vec4, floor, length, cos, sin, select } from "three/tsl";
import type { MaterialValue } from "../graph/types";
import { hashCell2ToVec3Seed } from "./noise/hash";

// SCATTER — DISTRIBUTION ONLY (a Substance "Tile Sampler"-style point sampler). It lays a jittered grid of
// `cells × cells` and, per cell, defines ONE stamp with per-cell random POSITION, SIZE, ROTATION and a
// per-cell DROP-OUT (`amount`) for sparse, non-uniform placement. It knows NOTHING about the silhouette: it
// outputs, for each fragment, the LOCAL coordinate in the nearest kept stamp's frame (centred, rotated,
// normalised so the stamp's nominal footprint is the unit disc), plus that stamp's random `value` and `size`.
// A downstream Shape node (or any node that reads `coord`) draws whatever it likes in that local frame — so
// Scatter is reusable for rocks, leaves, bricks, stamped textures, anything. (Distribution and shape are
// deliberately separate; conflating them made the node single-purpose.)
//
// Winner = nearest KEPT stamp centre (a Voronoi partition over the kept points). Because dropped cells are
// ignored, shapes are NOT clipped at empty-cell borders — gaps are simply where the chosen shape falls to 0.
// The 3×3 neighbour search catches stamps whose jittered centre sits in an adjacent cell. The per-cell hash
// wraps the integer cell index mod `cells`, so the offline bake tiles seamlessly.
//
// SHADER SIZE (this is a compile-time budget, not a style choice): pipeline compile scales ~linearly with
// emitted WGSL bytes, and this node is inlined into EVERY channel shader that depends on it. So the 3×3
// search is a real WGSL Loop (not a build-time unroll — that emitted 9 copies of the body), and the loop
// carries only what PICKING the winner needs: the two cell hashes, the jittered centre and the distance.
// Everything that describes the winner (rotation, footprint, value, size, local frame) is derived ONCE
// after the loop from the winning cell INDEX — the same "derive outside the loop" shape tile.ts uses. The
// arithmetic is unchanged, so the output is identical to the unrolled version, texel for texel.
type V = MaterialValue;
const PI = Math.PI;
// Loop's named-variable form (`{ dx }` in the body) isn't in three's exported types; cellular.ts casts the
// same way for its 3×3 worley search.
type NamedLoop = (
  params: { start: number; end: V; name: string; condition: "<" | "<=" },
  body: (variables: Record<string, V>) => void,
) => void;
const namedLoop = Loop as unknown as NamedLoop;
const FAR = 1e9; // "no kept stamp here" sentinel distance
const NO_STAMP = 10; // local coord when no stamp won — "far", so any shape reads 0

export interface ScatterUniforms {
  amount: V; // 0..1 fraction of cells that keep a stamp (drop-out → density)
  radius: V; // nominal stamp footprint as a fraction of a cell (sets the local-coord normalisation)
  sizeRandom: V; // 0..1 per-stamp size variance
  posRandom: V; // 0..1 per-stamp centre jitter (±0.5 cell)
  rotRandom: V; // 0..1 per-stamp rotation (×±π)
}

export interface ScatterResult {
  coord: V; // vec3: fragment in the nearest stamp's local frame (unit footprint), z = 0 → feed a Shape node
  value: V; // per-stamp random [0,1] → colour / shape seed / roughness variation
  size: V; // per-stamp size scale (1 ± sizeRandom) → e.g. multiply height so bigger stamps sit taller
}

export function scatterPattern(coord: V, cells: number, u: ScatterUniforms): ScatterResult {
  const C = cells;
  // An Fn returns one node, so pack (localX, localY, value, size) into a vec4 and unpack after.
  const packed = Fn(() => {
    const g = vec2(coord.x.mul(C), coord.y.mul(C)) as V; // grid space (unit cells)
    const baseX = floor(g.x) as V;
    const baseY = floor(g.y) as V;

    // The stamp centre of cell (cxf, cyf): cell centre + the seed-0 hash's ±0.5-cell position jitter.
    const centreOf = (cxf: V, cyf: V, h1: V): V =>
      vec2(
        cxf.add(0.5).add(h1.x.sub(0.5).mul(u.posRandom)),
        cyf.add(0.5).add(h1.y.sub(0.5).mul(u.posRandom)),
      ) as V;

    const nearD = float(FAR).toVar(); // distance to nearest kept stamp centre (UV)
    const bestX = float(0).toVar(); // winning cell index (float) — everything else is derived from it
    const bestY = float(0).toVar();

    // Pass: pick the winner. Dropped cells never win, so the strict `<` keeps the first of any tie in the
    // same visit order the unrolled version used (dy outer −1..1, dx inner −1..1).
    namedLoop({ start: -1, end: int(1), name: "dy", condition: "<=" }, ({ dy }) => {
      const cyf = baseY.add(float(dy)) as V;
      const cy = int(cyf);
      namedLoop({ start: -1, end: int(1), name: "dx", condition: "<=" }, ({ dx }) => {
        const cxf = baseX.add(float(dx)) as V;
        const cx = int(cxf);
        const h1 = hashCell2ToVec3Seed(cx, cy, 0, C, C) as V; // xy = position jitter, z = size
        const h2 = hashCell2ToVec3Seed(cx, cy, 1, C, C) as V; // x = rotation, y = value, z = drop-out

        const centre = centreOf(cxf, cyf, h1);
        const duv = vec2(g.x.sub(centre.x).div(C), g.y.sub(centre.y).div(C)) as V; // offset from centre, UV
        const dEff = select(h2.z.lessThan(u.amount), length(duv), float(FAR)) as V;

        const win = dEff.lessThan(nearD) as V;
        bestX.assign(select(win, cxf, bestX));
        bestY.assign(select(win, cyf, bestY));
        nearD.assign(select(win, dEff, nearD));
      });
    });

    // Describe the winner — done ONCE, from its cell index. Re-hashing (cx, cy) reproduces the exact values
    // the loop saw, so this is the same arithmetic the unrolled body ran for the winning cell.
    const found = nearD.lessThan(FAR) as V;
    const cx = int(bestX);
    const cy = int(bestY);
    const h1 = hashCell2ToVec3Seed(cx, cy, 0, C, C) as V;
    const h2 = hashCell2ToVec3Seed(cx, cy, 1, C, C) as V;

    const sizeScale = float(1).add(h1.z.sub(0.5).mul(2).mul(u.sizeRandom)) as V;
    const half = u.radius.div(C).mul(sizeScale) as V; // nominal footprint half-size, UV
    const centre = centreOf(bestX, bestY, h1);
    const duvX = g.x.sub(centre.x).div(C) as V;
    const duvY = g.y.sub(centre.y).div(C) as V;

    // local coord = offset rotated into the stamp's frame, normalised by the footprint half-size
    const angle = h2.x.sub(0.5).mul(2).mul(u.rotRandom).mul(PI).negate() as V;
    const ca = cos(angle) as V;
    const sa = sin(angle) as V;
    const lx = ca.mul(duvX).sub(sa.mul(duvY)).div(half.add(1e-9)) as V;
    const ly = sa.mul(duvX).add(ca.mul(duvY)).div(half.add(1e-9)) as V;

    // No kept stamp in the 3×3 → the untouched defaults of the unrolled version (far coord, value 0, size 1).
    return vec4(
      select(found, lx, float(NO_STAMP)),
      select(found, ly, float(NO_STAMP)),
      select(found, h2.y, float(0)),
      select(found, sizeScale, float(1)),
    );
  })() as V;
  return { coord: vec3(packed.x, packed.y, 0), value: packed.z, size: packed.w };
}
