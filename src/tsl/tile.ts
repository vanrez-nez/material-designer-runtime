import {
  Fn,
  float,
  int,
  vec2,
  vec3,
  vec4,
  floor,
  mod,
  min,
  max,
  abs,
  length,
  cos,
  sin,
  select,
  smoothstep,
} from "three/tsl";
import type { MaterialValue } from "../graph/types";
import { hashCell2, hashCell2ToVec3Seed } from "./noise/hash";

// Generic TILE GENERATOR (Substance-style), not a brick-specific node. It lays a rounded-rectangle tile in
// each cell of a `columns × rows` grid, with a per-row horizontal offset and per-tile randomisation of
// position, size, rotation, and value. Brick is just one preset of it (offset 0.5, offsetFreq 2, low
// randomness); the same node makes stack-bond tile (offset 0), planks (columns 1), and scattered cobblestone
// (size/position/rotation randomness + roundness).
//
// A jittered/scaled/rotated tile can spill into neighbouring cells, so — like Voronoi — each fragment tests
// the 3×3 neighbourhood of cells and keeps the tile it's most inside (max insideness). Distances are in UV
// space (per-axis ÷columns/÷rows) so gaps and rounding stay EVEN regardless of brick aspect, and rotation
// reads visually correct. Seamless in the offline bake: integer columns, and the caller snaps rows to a
// multiple of offsetFreq so the offset cycle closes at the tile edge.
type V = MaterialValue;
const TAU = 6.283185307179586;

export interface TileGrid {
  columns: number;
  rows: number;
  offsetFreq: number; // horizontal offset applied on rows where (row mod offsetFreq) != 0
}

export interface TileUniforms {
  rowOffset: V; // 0..1 of a cell (0.5 = running bond)
  gap: V; // mortar/grout half-width, UV units (even on both axes)
  roundness: V; // 0 = sharp corners, 1 = fully rounded (capsule/ellipse-ish)
  edge: V; // edge softness, UV units
  sizeRandom: V; // 0..1 per-tile size jitter
  posRandom: V; // 0..1 per-tile position jitter (cell units)
  rotRandom: V; // 0..1 per-tile rotation jitter (×±π)
}

export interface TileResult {
  mask: V; // 1 inside a tile, 0 in the gap/grout
  value: V; // per-tile random value [0,1] → colour / roughness / luminance variation
  // Fragment position LOCAL to the winning tile, in cell units (~[-0.5,0.5]), z = 0. The rotatable
  // per-tile coordinate — feed it through Vector Rotate (angle from cellRandom) to give each tile its own
  // oriented detail (e.g. wood grain). Resets per cell, so it is inherently seamless across the bake tile.
  cellCoord: V;
  // Three DECORRELATED per-tile randoms in [0,1) (x/y/z) from a fresh hash seed — for independent per-tile
  // angle / brightness / phase without stealing the `value` channel. Computed through the WRAPPED cell hash
  // (periods C, R) so cell C ≡ cell 0 and anything derived from it stays periodic across the tile edge.
  cellRandom: V;
}

export function tilePattern(coord: V, grid: TileGrid, u: TileUniforms): TileResult {
  const { columns: C, rows: R, offsetFreq: F } = grid;
  const g = vec2(coord.x.mul(C), coord.y.mul(R)) as V; // grid space (unit cells) — reused below

  // An Fn returns a single node, so the stateful 3×3 winner search packs (mask, value, cellX, cellY) into a
  // vec4 and unpacks after. Only the winning cell INDEX is carried out of the loop; cellCoord / cellRandom
  // are derived from it below (cheap, no iteration) — this keeps the loop a single pass.
  const packed = Fn(() => {
    const baseRow = floor(g.y) as V;
    const best = float(-1e9).toVar(); // winning tile insideness (-SDF; >0 inside)
    const bestVal = float(0).toVar();
    const bestCx = float(0).toVar(); // winning cell index (float), for per-cell coord/random below
    const bestCy = float(0).toVar();

    for (let dy = -1; dy <= 1; dy++) {
      const cyf = baseRow.add(dy) as V;
      const cy = int(cyf);
      // this row's horizontal offset (cell units)
      const off = select(mod(cyf, float(F)).notEqual(0), u.rowOffset, float(0)) as V;
      const colBase = floor(g.x.sub(off)) as V;
      for (let dx = -1; dx <= 1; dx++) {
        const cxf = colBase.add(dx) as V;
        const cx = int(cxf);
        const h1 = hashCell2ToVec3Seed(cx, cy, 0, C, R) as V; // xy = position jitter, z = size
        const h2 = hashCell2ToVec3Seed(cx, cy, 1, C, R) as V; // x = rotation, y = value

        // tile centre in grid space + per-tile position jitter (±0.5 cell × posRandom)
        const jx = h1.x.sub(0.5).mul(u.posRandom) as V;
        const jy = h1.y.sub(0.5).mul(u.posRandom) as V;
        const centerX = cxf.add(0.5).add(off).add(jx) as V;
        const centerY = cyf.add(0.5).add(jy) as V;

        // fragment offset from the tile centre, in isotropic UV units
        const duvX = g.x.sub(centerX).div(C) as V;
        const duvY = g.y.sub(centerY).div(R) as V;

        // rotate into the tile's frame (−angle), visually correct in UV space
        const angle = h2.x.sub(0.5).mul(2).mul(u.rotRandom).mul(TAU * 0.5).negate() as V;
        const ca = cos(angle) as V;
        const sa = sin(angle) as V;
        const rx = ca.mul(duvX).sub(sa.mul(duvY)) as V;
        const ry = sa.mul(duvX).add(ca.mul(duvY)) as V;

        // half extents (UV): half a cell, scaled by per-tile size, minus the even gap inset
        const sizeScale = float(1).add(h1.z.sub(0.5).mul(2).mul(u.sizeRandom)) as V;
        const hx = float(0.5).div(C).mul(sizeScale).sub(u.gap) as V;
        const hy = float(0.5).div(R).mul(sizeScale).sub(u.gap) as V;

        // signed distance to a rounded box (negative inside)
        const r = u.roundness.mul(min(hx, hy)) as V;
        const qx = abs(rx).sub(hx.sub(r)) as V;
        const qy = abs(ry).sub(hy.sub(r)) as V;
        const outside = length(vec2(max(qx, 0), max(qy, 0))) as V;
        const inside = min(max(qx, qy), 0) as V;
        const d = outside.add(inside).sub(r) as V; // <0 inside the tile
        const insideness = d.negate() as V;

        const win = insideness.greaterThan(best) as V;
        bestVal.assign(select(win, h2.y, bestVal));
        bestCx.assign(select(win, cxf, bestCx));
        bestCy.assign(select(win, cyf, bestCy));
        best.assign(select(win, insideness, best));
      }
    }

    // best is −SDF in UV: >0 inside, 0 at the edge, negative in the gap.
    return vec4(smoothstep(0, u.edge.add(1e-5), best), bestVal, bestCx, bestCy);
  })() as V;

  const mask = packed.x as V;
  const value = packed.y as V;
  const cx = packed.z as V; // winning cell index (float)
  const cy = packed.w as V;

  // Per-cell outputs, derived from the winning cell OUTSIDE the loop (no iteration). Recompute the winner's
  // centre exactly as the loop did (same seed-0 hash + offset) so cellCoord is the true tile-local position.
  // Every hash goes through the WRAPPED index (periods C, R via hashCell2ToVec3Seed) → seamless tiling.
  const cxi = int(cx);
  const cyi = int(cy);
  const off = select(mod(cy, float(F)).notEqual(0), u.rowOffset, float(0)) as V;
  const h1 = hashCell2ToVec3Seed(cxi, cyi, 0, C, R) as V;
  const centerX = cx.add(0.5).add(off).add(h1.x.sub(0.5).mul(u.posRandom)) as V;
  const centerY = cy.add(0.5).add(h1.y.sub(0.5).mul(u.posRandom)) as V;
  const cellCoord = vec3(g.x.sub(centerX), g.y.sub(centerY), 0) as V;
  const cellRandom = hashCell2ToVec3Seed(cxi, cyi, 2, C, R) as V; // seed 2 is free (loop uses 0 and 1)

  return { mask, value, cellCoord, cellRandom };
}

// Hexagon lattice — a regular hex grid (honeycomb). It's a Voronoi of the running-bond offset lattice: each
// hexagon is the cell of a feature point, so we find the nearest centre (F1) for the per-hex value and the
// distance to the bisector with neighbours (distance-to-edge) for the grout. Regular hexagons need a row
// spacing of columns·(2/√3); the node derives `rows` from `columns` (snapped even) for that, so the caller
// passes matching counts. Offset is fixed at half a cell (hex requires running bond). Seamless: integer
// columns + even rows. `gap` (UV) is the grout half-width, `edge` its softness.
export function hexPattern(coord: V, columns: number, rows: number, gap: V, edge: V): TileResult {
  const C = columns;
  const R = rows;
  const packed = Fn(() => {
    const g = vec2(coord.x.mul(C), coord.y.mul(R)) as V;
    const baseRow = floor(g.y) as V;

    // Pass 1 — nearest hex centre (F1): its UV position + per-hex value + winning cell index.
    const nearD = float(1e9).toVar();
    const nCx = float(0).toVar(); // nearest centre, UV
    const nCy = float(0).toVar();
    const nVal = float(0).toVar();
    const nCix = float(0).toVar(); // winning hex cell index (float), for per-cell coord/random below
    const nCiy = float(0).toVar();
    for (let dy = -1; dy <= 1; dy++) {
      const cyf = baseRow.add(dy) as V;
      const off = select(mod(cyf, float(2)).notEqual(0), float(0.5), float(0)) as V;
      const colBase = floor(g.x.sub(off)) as V;
      for (let dx = -1; dx <= 1; dx++) {
        const cxf = colBase.add(dx) as V;
        const cux = cxf.add(0.5).add(off).div(C) as V; // centre in UV
        const cuy = cyf.add(0.5).div(R) as V;
        const d = length(vec2(coord.x.sub(cux), coord.y.sub(cuy))) as V;
        const win = d.lessThan(nearD) as V;
        nearD.assign(select(win, d, nearD));
        nCx.assign(select(win, cux, nCx));
        nCy.assign(select(win, cuy, nCy));
        nCix.assign(select(win, cxf, nCix));
        nCiy.assign(select(win, cyf, nCiy));
        nVal.assign(select(win, hashCell2(int(cxf), int(cyf), C, R), nVal));
      }
    }

    // Pass 2 — distance to the nearest cell edge (bisector with each other centre).
    const edgeD = float(1e9).toVar();
    for (let dy = -1; dy <= 1; dy++) {
      const cyf = baseRow.add(dy) as V;
      const off = select(mod(cyf, float(2)).notEqual(0), float(0.5), float(0)) as V;
      const colBase = floor(g.x.sub(off)) as V;
      for (let dx = -1; dx <= 1; dx++) {
        const cxf = colBase.add(dx) as V;
        const cux = cxf.add(0.5).add(off).div(C) as V;
        const cuy = cyf.add(0.5).div(R) as V;
        const dcx = cux.sub(nCx) as V;
        const dcy = cuy.sub(nCy) as V;
        const len = length(vec2(dcx, dcy)).add(1e-9) as V;
        // signed distance from the fragment to the perpendicular bisector of (nearest, this) centre pair
        const midx = nCx.add(cux).mul(0.5) as V;
        const midy = nCy.add(cuy).mul(0.5) as V;
        // distance from the fragment INTO the nearest cell, toward this bisector (positive inside).
        const ed = midx.sub(coord.x).mul(dcx.div(len)).add(midy.sub(coord.y).mul(dcy.div(len))) as V;
        // skip the nearest centre itself (its bisector is undefined)
        const isSelf = len.lessThan(1e-4) as V;
        edgeD.assign(min(edgeD, select(isSelf, float(1e9), ed)));
      }
    }

    return vec4(smoothstep(gap, gap.add(edge).add(1e-5), edgeD), nVal, nCix, nCiy);
  })() as V;

  const mask = packed.x as V;
  const value = packed.y as V;
  const cix = packed.z as V; // winning hex cell index (float)
  const ciy = packed.w as V;

  // Per-cell outputs from the winning hex, derived outside the passes. Recompute the winner's UV centre from
  // its integer index (same running-bond offset the passes use) so cellCoord is tile-local; cellRandom uses
  // the WRAPPED cell hash (periods C, R) → seamless across the tile edge.
  const off = select(mod(ciy, float(2)).notEqual(0), float(0.5), float(0)) as V;
  const cux = cix.add(0.5).add(off).div(C) as V;
  const cuy = ciy.add(0.5).div(R) as V;
  const cellCoord = vec3(coord.x.sub(cux).mul(C), coord.y.sub(cuy).mul(R), 0) as V;
  const cellRandom = hashCell2ToVec3Seed(int(cix), int(ciy), 2, C, R) as V;

  return { mask, value, cellCoord, cellRandom };
}
