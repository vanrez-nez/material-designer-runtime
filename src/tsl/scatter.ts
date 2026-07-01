import { Fn, float, int, vec2, vec3, vec4, floor, length, cos, sin, select } from "three/tsl";
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
type V = MaterialValue;
const PI = Math.PI;

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

    const nearD = float(1e9).toVar(); // distance to nearest kept stamp centre (UV)
    const locX = float(10).toVar(); // winner's local coord (10 = "far", shape → 0 when no stamp)
    const locY = float(10).toVar();
    const val = float(0).toVar();
    const siz = float(1).toVar();

    for (let dy = -1; dy <= 1; dy++) {
      const cyf = baseY.add(dy) as V;
      const cy = int(cyf);
      for (let dx = -1; dx <= 1; dx++) {
        const cxf = baseX.add(dx) as V;
        const cx = int(cxf);
        const h1 = hashCell2ToVec3Seed(cx, cy, 0, C, C) as V; // xy = position jitter, z = size
        const h2 = hashCell2ToVec3Seed(cx, cy, 1, C, C) as V; // x = rotation, y = value, z = drop-out

        const keep = h2.z.lessThan(u.amount) as V;
        const sizeScale = float(1).add(h1.z.sub(0.5).mul(2).mul(u.sizeRandom)) as V;
        const half = u.radius.div(C).mul(sizeScale) as V; // nominal footprint half-size, UV

        const jx = h1.x.sub(0.5).mul(u.posRandom) as V;
        const jy = h1.y.sub(0.5).mul(u.posRandom) as V;
        const centerX = cxf.add(0.5).add(jx) as V;
        const centerY = cyf.add(0.5).add(jy) as V;

        const duvX = g.x.sub(centerX).div(C) as V; // fragment offset from centre, UV
        const duvY = g.y.sub(centerY).div(C) as V;
        const d = length(vec2(duvX, duvY)) as V;
        const dEff = select(keep, d, float(1e9)) as V; // dropped cells never win

        // local coord = offset rotated into the stamp's frame, normalised by the footprint half-size
        const angle = h2.x.sub(0.5).mul(2).mul(u.rotRandom).mul(PI).negate() as V;
        const ca = cos(angle) as V;
        const sa = sin(angle) as V;
        const lx = ca.mul(duvX).sub(sa.mul(duvY)).div(half.add(1e-9)) as V;
        const ly = sa.mul(duvX).add(ca.mul(duvY)).div(half.add(1e-9)) as V;

        const win = dEff.lessThan(nearD) as V;
        locX.assign(select(win, lx, locX));
        locY.assign(select(win, ly, locY));
        val.assign(select(win, h2.y, val));
        siz.assign(select(win, sizeScale, siz));
        nearD.assign(select(win, dEff, nearD));
      }
    }

    return vec4(locX, locY, val, siz);
  })() as V;
  return { coord: vec3(packed.x, packed.y, 0), value: packed.z, size: packed.w };
}
